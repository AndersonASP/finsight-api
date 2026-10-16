import { Prisma, type TransactionType } from "@prisma/client";
import { prisma } from "../../core/db/prisma.js";
import { AppError } from "../../core/http/errors.js";
import { createPaymentInTx } from "../invoice-payments/invoice-payments.service.js";
import { createPurchaseInTx, findOrCreateInvoice } from "../purchases/purchases.service.js";
import { generateInstallmentPlan } from "../../services/installment-generator.service.js";

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
  const [transactions, purchases, invoicePayments, budgetItems] = await Promise.all([
    prisma.scenarioTransaction.findMany({ where: { scenarioId } }),
    prisma.scenarioPurchase.findMany({ where: { scenarioId }, include: { installments: true } }),
    prisma.scenarioInvoicePayment.findMany({ where: { scenarioId } }),
    prisma.scenarioBudgetItem.findMany({ where: { scenarioId } }),
  ]);
  return { ...scenario, transactions, purchases, invoicePayments, budgetItems };
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

export interface ScenarioInvoicePaymentInput {
  accountId: string;
  paymentDate: Date;
  amount: string;
  interestAmount?: string;
  realInvoiceId?: string;
  cardId?: string;
  periodYear?: number;
  periodMonth?: number;
}

export async function addScenarioInvoicePayment(userId: string, scenarioId: string, input: ScenarioInvoicePaymentInput) {
  const scenario = await getOwnedScenario(userId, scenarioId);
  assertDraft(scenario);
  if (!input.realInvoiceId && !(input.cardId && input.periodYear && input.periodMonth)) {
    throw AppError.badRequest("Provide either realInvoiceId or cardId+periodYear+periodMonth");
  }
  return prisma.scenarioInvoicePayment.create({ data: { scenarioId, ...input } });
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

  const [transactions, purchases, invoicePayments, budgetItems] = await Promise.all([
    prisma.scenarioTransaction.findMany({ where: { scenarioId } }),
    prisma.scenarioPurchase.findMany({ where: { scenarioId } }),
    prisma.scenarioInvoicePayment.findMany({ where: { scenarioId } }),
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

    for (const payment of invoicePayments) {
      let invoiceId = payment.realInvoiceId;
      if (!invoiceId) {
        if (!payment.cardId || !payment.periodYear || !payment.periodMonth) {
          throw AppError.badRequest("Scenario payment is missing a target invoice");
        }
        const invoice = await findOrCreateInvoice(tx, userId, payment.cardId, {
          year: payment.periodYear,
          month: payment.periodMonth,
        });
        invoiceId = invoice.id;
      }
      await createPaymentInTx(tx, userId, invoiceId, {
        accountId: payment.accountId,
        paymentDate: payment.paymentDate,
        amount: payment.amount.toString(),
        interestAmount: payment.interestAmount.toString(),
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
