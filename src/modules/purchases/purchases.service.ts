import { Prisma } from "@prisma/client";
import { prisma } from "../../core/db/prisma.js";
import { AppError } from "../../core/http/errors.js";
import { generateInstallmentPlan } from "../../services/installment-generator.service.js";
import { computeClosingDate, computeDueDate } from "../../services/invoice-cycle.service.js";

export interface PurchaseInput {
  cardId: string;
  purchaseDate: Date;
  description: string;
  amount: string;
  categoryId?: string;
  installmentsCount?: number;
  knownCharges?: string;
  invoiceOverrideId?: string;
  recurringCardPurchaseId?: string;
  occurrenceIndex?: number;
}

export async function findOrCreateInvoice(
  tx: Prisma.TransactionClient,
  userId: string,
  cardId: string,
  period: { year: number; month: number }
) {
  const existing = await tx.invoice.findUnique({
    where: { cardId_periodYear_periodMonth: { cardId, periodYear: period.year, periodMonth: period.month } },
  });
  if (existing) return existing;

  const card = await tx.card.findUniqueOrThrow({ where: { id: cardId } });
  const closingDate = computeClosingDate(card, period);
  // A backdated purchase can land in a cycle whose closing date has already
  // passed — the invoice is born already closed rather than waiting on a job.
  const status = new Date() >= closingDate ? "closed" : "open";

  return tx.invoice.create({
    data: {
      cardId,
      userId,
      periodYear: period.year,
      periodMonth: period.month,
      closingDate,
      dueDate: computeDueDate(card, period),
      status,
    },
  });
}

async function getOwnedPurchase(userId: string, purchaseId: string) {
  const purchase = await prisma.purchase.findUnique({ where: { id: purchaseId }, include: { installments: true } });
  if (!purchase || purchase.userId !== userId) throw AppError.notFound("Purchase not found");
  return purchase;
}

export async function listPurchases(userId: string, filter: { cardId?: string; from?: Date; to?: Date }) {
  return prisma.purchase.findMany({
    where: {
      userId,
      ...(filter.cardId ? { cardId: filter.cardId } : {}),
      ...(filter.from || filter.to
        ? {
            purchaseDate: {
              ...(filter.from ? { gte: filter.from } : {}),
              ...(filter.to ? { lte: filter.to } : {}),
            },
          }
        : {}),
    },
    include: { installments: true },
    orderBy: { purchaseDate: "desc" },
  });
}

export async function getPurchase(userId: string, purchaseId: string) {
  return getOwnedPurchase(userId, purchaseId);
}

/**
 * Only what doesn't touch money: description and tag. Amount, date, card or
 * installments live in the generated installments/invoices — changing those
 * means deleting and re-creating the purchase.
 */
export async function updatePurchaseLabels(
  userId: string,
  purchaseId: string,
  input: { description?: string; categoryId?: string | null }
) {
  await getOwnedPurchase(userId, purchaseId);
  if (input.categoryId) {
    const category = await prisma.category.findUnique({ where: { id: input.categoryId } });
    if (!category || category.userId !== userId) throw AppError.notFound("Category not found");
  }
  return prisma.purchase.update({ where: { id: purchaseId }, data: input });
}

/**
 * Creates the purchase and all of its installments, finding-or-creating each
 * installment's invoice as needed (RF-11: no duplication, every installment
 * linked back to the original purchase). Takes a transaction client so it can
 * be reused as-is from `confirmScenario` (RF-13), materializing a simulated
 * purchase through the exact same logic as a real one.
 */
export async function createPurchaseInTx(tx: Prisma.TransactionClient, userId: string, input: PurchaseInput) {
  const card = await tx.card.findUnique({ where: { id: input.cardId } });
  if (!card || card.userId !== userId) throw AppError.notFound("Card not found");

  const installmentsCount = input.installmentsCount ?? 1;
  if (installmentsCount < 1) throw AppError.badRequest("installmentsCount must be >= 1");

  let firstPeriodOverride: { year: number; month: number } | undefined;
  if (input.invoiceOverrideId) {
    const overrideInvoice = await tx.invoice.findUnique({ where: { id: input.invoiceOverrideId } });
    if (!overrideInvoice || overrideInvoice.cardId !== input.cardId || overrideInvoice.userId !== userId) {
      throw AppError.badRequest("invoiceOverrideId must reference an invoice on the same card");
    }
    firstPeriodOverride = { year: overrideInvoice.periodYear, month: overrideInvoice.periodMonth };
  }

  const plan = generateInstallmentPlan({
    card,
    purchaseDate: input.purchaseDate,
    totalAmount: new Prisma.Decimal(input.amount),
    installmentsCount,
    firstPeriodOverride,
  });

  const purchase = await tx.purchase.create({
    data: {
      userId,
      cardId: input.cardId,
      purchaseDate: input.purchaseDate,
      description: input.description,
      amount: input.amount,
      categoryId: input.categoryId,
      installmentsCount,
      knownCharges: input.knownCharges ?? "0",
      invoiceOverrideId: input.invoiceOverrideId,
      recurringCardPurchaseId: input.recurringCardPurchaseId,
      occurrenceIndex: input.occurrenceIndex,
    },
  });

  const installments = [];
  for (const item of plan) {
    const invoice = await findOrCreateInvoice(tx, userId, input.cardId, item.period);
    const installment = await tx.installment.create({
      data: {
        purchaseId: purchase.id,
        sequence: item.sequence,
        amount: item.amount,
        invoiceId: invoice.id,
        dueDate: item.dueDate,
        status: invoice.status === "open" ? "pending" : "invoiced",
      },
    });
    installments.push(installment);
  }

  return { ...purchase, installments };
}

export async function createPurchase(userId: string, input: PurchaseInput) {
  return prisma.$transaction((tx) => createPurchaseInTx(tx, userId, input));
}

/**
 * `scope: "future"` only does something special when this purchase is one
 * occurrence of a `RecurringCardPurchase` (a subscription): it removes this
 * occurrence and every later one in the same series (by `occurrenceIndex`,
 * mirroring transactions.service.ts's deleteTransaction), leaving past
 * occurrences untouched. Otherwise (or for a one-off purchase) it just
 * deletes the one row, same as before.
 */
export async function deletePurchase(userId: string, purchaseId: string, scope: "this" | "future" = "this") {
  const purchase = await getOwnedPurchase(userId, purchaseId);

  if (scope === "future" && purchase.recurringCardPurchaseId && purchase.occurrenceIndex != null) {
    const futurePurchases = await prisma.purchase.findMany({
      where: {
        userId,
        recurringCardPurchaseId: purchase.recurringCardPurchaseId,
        occurrenceIndex: { gte: purchase.occurrenceIndex },
      },
      include: { installments: true },
    });
    const hasNonPending = futurePurchases.some((p) => p.installments.some((i) => i.status !== "pending"));
    if (hasNonPending) {
      throw AppError.conflict("Cannot delete a purchase with invoiced or paid installments");
    }
    await prisma.purchase.deleteMany({
      where: {
        userId,
        recurringCardPurchaseId: purchase.recurringCardPurchaseId,
        occurrenceIndex: { gte: purchase.occurrenceIndex },
      },
    });
    return;
  }

  const hasNonPending = purchase.installments.some((i) => i.status !== "pending");
  if (hasNonPending) {
    throw AppError.conflict("Cannot delete a purchase with invoiced or paid installments");
  }
  await prisma.purchase.delete({ where: { id: purchaseId } });
}
