import { Prisma, type DebtKind, type DebtStatus, type DebtType } from "@prisma/client";
import { prisma } from "../../core/db/prisma.js";
import { startOfUtcDay } from "../../core/http/date.js";
import { AppError } from "../../core/http/errors.js";
import { installmentDueDate } from "../wealth/debt-outstanding.js";
import { getOwnedAccount } from "../accounts/accounts.service.js";

export interface DebtInput {
  creditor: string;
  type: DebtType;
  status?: DebtStatus;
  kind?: DebtKind;
  originalAmount?: string;
  currentBalance?: string;
  installmentAmount?: string;
  installmentDueDay?: number;
  installmentsTotal?: number;
  currentInstallment?: number;
  firstInstallmentDate?: Date;
  payoffAmount?: string | null;
  monthlyInterestRate?: string | null;
  notes?: string;
}

/**
 * "Estou na parcela X" → due date of installment #1: X is the installment
 * whose due date falls in the current month, so #1 was X−1 months earlier.
 */
export function firstInstallmentDateFrom(currentInstallment: number, dueDay: number, today: Date): Date {
  const thisMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  return installmentDueDate(thisMonth, dueDay, -(currentInstallment - 1));
}

/** Turns the API input into Prisma data, deriving the dates the user never types. */
function toDebtData(input: Partial<DebtInput>, today: Date) {
  const { currentInstallment, payoffAmount, ...rest } = input;
  const data: Prisma.DebtUncheckedUpdateInput = { ...rest };
  if (currentInstallment != null) {
    if (input.installmentDueDay == null) {
      throw AppError.badRequest("installmentDueDay is required with currentInstallment");
    }
    if (input.installmentsTotal != null && currentInstallment > input.installmentsTotal) {
      throw AppError.badRequest("currentInstallment cannot exceed installmentsTotal");
    }
    data.firstInstallmentDate = firstInstallmentDateFrom(currentInstallment, input.installmentDueDay, today);
  }
  if (input.currentBalance != null) data.balanceUpdatedAt = today;
  if (payoffAmount !== undefined) {
    data.payoffAmount = payoffAmount;
    data.payoffAmountAt = payoffAmount == null ? null : today;
  }
  return data;
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
  if (input.currentBalance != null && new Prisma.Decimal(input.currentBalance).lessThan(0)) {
    throw AppError.badRequest("currentBalance cannot be negative");
  }
  const kind = input.kind ?? (input.installmentsTotal != null && input.installmentAmount != null ? "parcela_fixa" : "saldo_variavel");
  if (kind === "saldo_variavel" && input.currentBalance == null) {
    throw AppError.badRequest("currentBalance is required for saldo_variavel");
  }
  if (kind === "parcela_fixa" && (input.installmentsTotal == null || input.installmentAmount == null)) {
    throw AppError.badRequest("installmentsTotal and installmentAmount are required for parcela_fixa");
  }
  const today = startOfUtcDay(new Date());
  const data = toDebtData({ ...input, kind }, today) as Prisma.DebtUncheckedCreateInput;
  return prisma.debt.create({
    data: {
      ...data,
      userId,
      creditor: input.creditor,
      type: input.type,
      status: input.status ?? "em_dia",
      currentBalance: input.currentBalance ?? "0",
      balanceUpdatedAt: today,
    },
  });
}

export async function updateDebt(userId: string, debtId: string, input: Partial<DebtInput>) {
  const debt = await getOwnedDebt(userId, debtId);
  if (input.currentBalance != null && new Prisma.Decimal(input.currentBalance).lessThan(0)) {
    throw AppError.badRequest("currentBalance cannot be negative");
  }
  // "Parcela X" needs the due day even when only X changed.
  const withDueDay = { ...input, installmentDueDay: input.installmentDueDay ?? debt.installmentDueDay ?? undefined };
  return prisma.debt.update({ where: { id: debtId }, data: toDebtData(withDueDay, startOfUtcDay(new Date())) });
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
