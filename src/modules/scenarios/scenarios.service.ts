import { Prisma, type TransactionType } from "@prisma/client";
import { prisma } from "../../core/db/prisma.js";
import { AppError } from "../../core/http/errors.js";
import { createPurchaseInTx } from "../purchases/purchases.service.js";
import { generateInstallmentPlan } from "../../services/installment-generator.service.js";
import { getDailyBalance, getDayDetail, type DayDetailItem } from "../reports/reports.service.js";

export async function getOwnedScenario(userId: string, scenarioId: string) {
  const scenario = await prisma.scenario.findUnique({ where: { id: scenarioId } });
  if (!scenario || scenario.userId !== userId) throw AppError.notFound("Scenario not found");
  return scenario;
}

function assertDraft(scenario: { status: string }) {
  if (scenario.status !== "draft") {
    throw AppError.conflict("Scenario is no longer a draft (already confirmed or discarded)");
  }
}

export async function listScenarios(userId: string) {
  return prisma.scenario.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
}

export async function createScenario(userId: string, input: { name: string; description?: string }) {
  return prisma.scenario.create({
    data: { userId, name: input.name, description: input.description, baseSnapshotDate: new Date() },
  });
}

export async function getScenarioDetail(userId: string, scenarioId: string) {
  const scenario = await getOwnedScenario(userId, scenarioId);
  const [transactions, purchases, budgetItems] = await Promise.all([
    prisma.scenarioTransaction.findMany({ where: { scenarioId } }),
    prisma.scenarioPurchase.findMany({ where: { scenarioId }, include: { installments: true } }),
    prisma.scenarioBudgetItem.findMany({ where: { scenarioId } }),
  ]);
  return { ...scenario, transactions, purchases, budgetItems };
}

// --- shadow sub-resources ---------------------------------------------------

export interface ScenarioTransactionInput {
  accountId: string;
  type: TransactionType;
  amount: string;
  date: Date;
  categoryId?: string;
  description?: string;
  counterpartAccountId?: string;
}

export async function addScenarioTransaction(userId: string, scenarioId: string, input: ScenarioTransactionInput) {
  const scenario = await getOwnedScenario(userId, scenarioId);
  assertDraft(scenario);
  return prisma.scenarioTransaction.create({ data: { scenarioId, ...input } });
}

export interface ScenarioPurchaseInput {
  cardId: string;
  purchaseDate: Date;
  description: string;
  amount: string;
  categoryId?: string;
  installmentsCount?: number;
  knownCharges?: string;
}

/**
 * Mirrors `createPurchaseInTx`'s cycle/installment logic, but writes to the
 * shadow tables and only *reads* real invoices to link `realInvoiceId` for
 * display — it never creates a real invoice while still a draft.
 */
export async function addScenarioPurchase(userId: string, scenarioId: string, input: ScenarioPurchaseInput) {
  const scenario = await getOwnedScenario(userId, scenarioId);
  assertDraft(scenario);

  const card = await prisma.card.findUnique({ where: { id: input.cardId } });
  if (!card || card.userId !== userId) throw AppError.notFound("Card not found");

  const installmentsCount = input.installmentsCount ?? 1;
  const plan = generateInstallmentPlan({
    card,
    purchaseDate: input.purchaseDate,
    totalAmount: new Prisma.Decimal(input.amount),
    installmentsCount,
  });

  return prisma.$transaction(async (tx) => {
    const purchase = await tx.scenarioPurchase.create({
      data: {
        scenarioId,
        cardId: input.cardId,
        purchaseDate: input.purchaseDate,
        description: input.description,
        amount: input.amount,
        categoryId: input.categoryId,
        installmentsCount,
        knownCharges: input.knownCharges ?? "0",
      },
    });

    const installments = [];
    for (const item of plan) {
      const realInvoice = await tx.invoice.findUnique({
        where: { cardId_periodYear_periodMonth: { cardId: input.cardId, periodYear: item.period.year, periodMonth: item.period.month } },
      });
      const installment = await tx.scenarioInstallment.create({
        data: {
          scenarioPurchaseId: purchase.id,
          sequence: item.sequence,
          amount: item.amount,
          cardId: input.cardId,
          periodYear: item.period.year,
          periodMonth: item.period.month,
          dueDate: item.dueDate,
          realInvoiceId: realInvoice?.id,
        },
      });
      installments.push(installment);
    }

    return { ...purchase, installments };
  });
}

/**
 * Mirrors transactions.service.ts's deleteTransaction/purchases.service.ts's
 * deletePurchase ownership checks, scoped one level deeper (through the
 * scenario) since a shadow row has no userId of its own.
 */
export async function removeScenarioTransaction(userId: string, scenarioId: string, transactionId: string) {
  const scenario = await getOwnedScenario(userId, scenarioId);
  assertDraft(scenario);
  const transaction = await prisma.scenarioTransaction.findUnique({ where: { id: transactionId } });
  if (!transaction || transaction.scenarioId !== scenarioId) throw AppError.notFound("Scenario transaction not found");
  await prisma.scenarioTransaction.delete({ where: { id: transactionId } });
}

export async function removeScenarioPurchase(userId: string, scenarioId: string, purchaseId: string) {
  const scenario = await getOwnedScenario(userId, scenarioId);
  assertDraft(scenario);
  const purchase = await prisma.scenarioPurchase.findUnique({ where: { id: purchaseId } });
  if (!purchase || purchase.scenarioId !== scenarioId) throw AppError.notFound("Scenario purchase not found");
  // Installments cascade via the FK.
  await prisma.scenarioPurchase.delete({ where: { id: purchaseId } });
}

/** Thin ownership-checking wrapper around reports.service.ts's getDailyBalance (the actual overlay math lives there). */
export async function getScenarioDailyBalance(userId: string, scenarioId: string, year: number, month: number) {
  await getOwnedScenario(userId, scenarioId);
  return getDailyBalance(userId, year, month, undefined, scenarioId);
}

export interface ScenarioShadowItem {
  id: string;
  kind: "transaction" | "purchase";
  type: string;
  description: string;
  date: string;
  amount: string;
  categoryName: string | null;
  categoryColor: string | null;
}

/**
 * The real day's items (read-only here — a simulation never edits history)
 * plus this scenario's own shadow rows for that day (removable — see
 * removeScenarioTransaction/removeScenarioPurchase above).
 */
export async function getScenarioDayDetail(
  userId: string,
  scenarioId: string,
  date: Date
): Promise<{ real: DayDetailItem[]; shadow: ScenarioShadowItem[] }> {
  await getOwnedScenario(userId, scenarioId);
  const nextDay = new Date(date.getTime() + 24 * 60 * 60 * 1000);

  const [real, transactions, purchases] = await Promise.all([
    getDayDetail(userId, date),
    prisma.scenarioTransaction.findMany({
      where: { scenarioId, date: { gte: date, lt: nextDay } },
      include: { category: true },
    }),
    // Card spending on the invoice due date, like the real day detail.
    prisma.scenarioInstallment.findMany({
      where: { scenarioPurchase: { scenarioId }, dueDate: { gte: date, lt: nextDay } },
      include: { scenarioPurchase: { include: { category: true } } },
    }),
  ]);

  const shadow: ScenarioShadowItem[] = [
    ...transactions.map((t) => ({
      id: t.id,
      kind: "transaction" as const,
      type: t.type,
      description: t.description?.trim() ? t.description : t.type,
      date: t.date.toISOString().slice(0, 10),
      amount: new Prisma.Decimal(t.amount).toFixed(2),
      categoryName: t.category?.name ?? null,
      categoryColor: t.category?.color ?? null,
    })),
    ...purchases.map((installment) => ({
      // The purchase's id: removing the shadow item removes the whole purchase.
      id: installment.scenarioPurchase.id,
      kind: "purchase" as const,
      type: "cartao",
      description: installment.scenarioPurchase.description,
      date: installment.dueDate.toISOString().slice(0, 10),
      amount: new Prisma.Decimal(installment.amount).toFixed(2),
      categoryName: installment.scenarioPurchase.category?.name ?? null,
      categoryColor: installment.scenarioPurchase.category?.color ?? null,
    })),
  ];

  return { real, shadow };
}

export interface ScenarioBudgetItemInput {
  name: string;
  amount: string;
  categoryId?: string;
}

export async function addScenarioBudgetItem(userId: string, scenarioId: string, input: ScenarioBudgetItemInput) {
  const scenario = await getOwnedScenario(userId, scenarioId);
  assertDraft(scenario);
  return prisma.scenarioBudgetItem.create({ data: { scenarioId, ...input } });
}

// --- lifecycle ---------------------------------------------------------------

export async function discardScenario(userId: string, scenarioId: string) {
  const scenario = await getOwnedScenario(userId, scenarioId);
  assertDraft(scenario);
  // Shadow rows cascade-delete via the FK; the scenario row itself is kept as
  // an auditable "discarded" record rather than being deleted outright.
  await prisma.scenario.update({ where: { id: scenarioId }, data: { status: "discarded", discardedAt: new Date() } });
}

/**
 * Materializes every shadow row into the real tables, reusing the exact same
 * domain services (purchase/payment creation) a direct API call would use —
 * in one transaction, so a mid-way failure leaves real data untouched.
 */
export async function confirmScenario(userId: string, scenarioId: string) {
  const scenario = await getOwnedScenario(userId, scenarioId);
  assertDraft(scenario);

  const [transactions, purchases, budgetItems] = await Promise.all([
    prisma.scenarioTransaction.findMany({ where: { scenarioId } }),
    prisma.scenarioPurchase.findMany({ where: { scenarioId } }),
    prisma.scenarioBudgetItem.findMany({ where: { scenarioId } }),
  ]);

  await prisma.$transaction(async (tx) => {
    for (const t of transactions) {
      await tx.transaction.create({
        data: {
          userId,
          accountId: t.accountId,
          counterpartAccountId: t.counterpartAccountId,
          type: t.type,
          amount: t.amount,
          categoryId: t.categoryId,
          description: t.description,
          date: t.date,
        },
      });
    }

    for (const p of purchases) {
      await createPurchaseInTx(tx, userId, {
        cardId: p.cardId,
        purchaseDate: p.purchaseDate,
        description: p.description,
        amount: p.amount.toString(),
        categoryId: p.categoryId ?? undefined,
        installmentsCount: p.installmentsCount,
        knownCharges: p.knownCharges.toString(),
      });
    }

    for (const item of budgetItems) {
      await tx.budgetItem.create({
        data: { userId, name: item.name, amount: item.amount, categoryId: item.categoryId },
      });
    }

    await tx.scenario.update({ where: { id: scenarioId }, data: { status: "confirmed", confirmedAt: new Date() } });
  });
}
