import { Prisma, type DebtStatus, type DebtType } from "@prisma/client";
import { prisma } from "../../core/db/prisma.js";
import { AppError } from "../../core/http/errors.js";
import { getOwnedAccount } from "../accounts/accounts.service.js";

export interface DebtInput {
  creditor: string;
  type: DebtType;
  status?: DebtStatus;
  originalAmount?: string;
  currentBalance: string;
  installmentAmount?: string;
  installmentDueDay?: number;
  installmentsTotal?: number;
  notes?: string;
}

export interface CreatePaymentInput {
  accountId: string;
  amount: string;
  paymentDate: Date;
  notes?: string;
}

async function getOwnedDebt(userId: string, debtId: string) {
  const debt = await prisma.debt.findUnique({ where: { id: debtId } });
  if (!debt || debt.userId !== userId) throw AppError.notFound("Debt not found");
  return debt;
}

export interface ListDebtsFilter {
  status?: DebtStatus;
}

export async function listDebts(userId: string, filter: ListDebtsFilter) {
  return prisma.debt.findMany({
    where: { userId, ...(filter.status ? { status: filter.status } : {}) },
    orderBy: { createdAt: "asc" },
  });
}

export async function getDebt(userId: string, debtId: string) {
  const debt = await getOwnedDebt(userId, debtId);
  const payments = await prisma.debtPayment.findMany({ where: { debtId }, orderBy: { paymentDate: "asc" } });
  return { debt, payments };
}

export async function createDebt(userId: string, input: DebtInput) {
  if (new Prisma.Decimal(input.currentBalance).lessThan(0)) {
    throw AppError.badRequest("currentBalance cannot be negative");
  }
  return prisma.debt.create({
    data: {
      userId,
      creditor: input.creditor,
      type: input.type,
      status: input.status ?? "em_dia",
      originalAmount: input.originalAmount,
      currentBalance: input.currentBalance,
      installmentAmount: input.installmentAmount,
      installmentDueDay: input.installmentDueDay,
      installmentsTotal: input.installmentsTotal,
      notes: input.notes,
    },
  });
}

export async function updateDebt(userId: string, debtId: string, input: Partial<DebtInput>) {
  await getOwnedDebt(userId, debtId);
  if (input.currentBalance != null && new Prisma.Decimal(input.currentBalance).lessThan(0)) {
    throw AppError.badRequest("currentBalance cannot be negative");
  }
  return prisma.debt.update({ where: { id: debtId }, data: input });
}

export async function deleteDebt(userId: string, debtId: string) {
  await getOwnedDebt(userId, debtId);
  await prisma.debt.delete({ where: { id: debtId } });
}

export async function listPayments(userId: string, debtId: string) {
  await getOwnedDebt(userId, debtId);
  return prisma.debtPayment.findMany({ where: { debtId }, orderBy: { paymentDate: "asc" } });
}

/**
 * Registers a payment against a debt: subtracts `amount` from the debt's
 * `currentBalance` (never below zero — an overpayment is rejected rather
 * than inventing a credit balance, same stance as reserve-loan repayments),
 * stores the resulting balance as an audit snapshot, and flips the debt to
 * "paga" once it reaches zero. The payment itself also leaves `accountId`'s
 * real balance (via getAccountBalance's debtPayments aggregate) — paying a
 * debt is real money leaving an account, not just a tracker update.
 */
export async function createPayment(userId: string, debtId: string, input: CreatePaymentInput) {
  return prisma.$transaction(async (tx) => {
    const debt = await tx.debt.findUnique({ where: { id: debtId } });
    if (!debt || debt.userId !== userId) throw AppError.notFound("Debt not found");
    if (debt.status === "paga") throw AppError.badRequest("Debt is already paid off");

    await getOwnedAccount(userId, input.accountId);

    const amount = new Prisma.Decimal(input.amount);
    if (amount.lessThanOrEqualTo(0)) throw AppError.badRequest("amount must be greater than zero");

    const currentBalance = new Prisma.Decimal(debt.currentBalance);
    if (amount.greaterThan(currentBalance)) {
      throw AppError.badRequest("amount exceeds the debt's current balance");
    }
    const balanceAfter = currentBalance.minus(amount);

    const payment = await tx.debtPayment.create({
      data: {
        debtId,
        accountId: input.accountId,
        paymentDate: input.paymentDate,
        amount: input.amount,
        balanceAfter,
        notes: input.notes,
      },
    });

    await tx.debt.update({
      where: { id: debtId },
      data: {
        currentBalance: balanceAfter,
        installmentsPaid: debt.installmentsTotal != null ? { increment: 1 } : undefined,
        status: balanceAfter.isZero() ? "paga" : debt.status,
      },
    });

    return payment;
  });
}
