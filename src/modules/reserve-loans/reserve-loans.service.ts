import { Prisma, type ReserveLoanStatus } from "@prisma/client";
import { prisma } from "../../core/db/prisma.js";
import { AppError } from "../../core/http/errors.js";
import { getOwnedAccount, getAccountBalance } from "../accounts/accounts.service.js";
import { applyRepayment, computeLoanState } from "./interest.js";

export interface CreateLoanInput {
  reserveAccountId: string;
  destinationAccountId: string;
  principal: string;
  borrowDate: Date;
  /** % ao mês, always > 0 (validated by the route). */
  monthlyInterestRate?: number;
  description?: string;
}

/** Borrowing from the reserve is never free — it's how the app nudges the money back in. */
export const DEFAULT_MONTHLY_INTEREST_RATE = 10;

export interface CreateRepaymentInput {
  repaymentDate: Date;
  amount: string;
}

export interface ListLoansFilter {
  accountId?: string;
  status?: ReserveLoanStatus;
}

async function getOwnedLoan(userId: string, loanId: string) {
  const loan = await prisma.reserveLoan.findUnique({ where: { id: loanId } });
  if (!loan || loan.userId !== userId) throw AppError.notFound("Reserve loan not found");
  return loan;
}

function serializeState(state: ReturnType<typeof computeLoanState>) {
  return {
    outstandingPrincipal: state.outstandingPrincipal.toFixed(2),
    accruedInterest: state.accruedInterest.toFixed(2),
    totalOwed: state.totalOwed.toFixed(2),
  };
}

export async function listLoans(userId: string, filter: ListLoansFilter) {
  return prisma.reserveLoan.findMany({
    where: {
      userId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.accountId
        ? { OR: [{ reserveAccountId: filter.accountId }, { destinationAccountId: filter.accountId }] }
        : {}),
    },
    orderBy: { borrowDate: "desc" },
  });
}

/**
 * Borrowing moves real principal out of the reserve account at creation
 * time (see accounts.service.ts's getAccountBalance), so it's capped at
 * what the reserve actually has available as of borrowDate — a reserve
 * account is never allowed to go negative from a loan.
 */
export async function createLoan(userId: string, input: CreateLoanInput) {
  const reserveAccount = await getOwnedAccount(userId, input.reserveAccountId);
  if (reserveAccount.type !== "savings_reserve") {
    throw AppError.badRequest("reserveAccountId must be a savings_reserve account");
  }
  const destinationAccount = await getOwnedAccount(userId, input.destinationAccountId);
  if (destinationAccount.id === reserveAccount.id) {
    throw AppError.badRequest("destinationAccountId cannot equal reserveAccountId");
  }

  const principal = new Prisma.Decimal(input.principal);
  if (principal.lessThanOrEqualTo(0)) {
    throw AppError.badRequest("principal must be greater than zero");
  }

  const reserveBalance = await getAccountBalance(userId, reserveAccount.id, input.borrowDate);
  if (principal.greaterThan(reserveBalance)) {
    throw AppError.badRequest("principal exceeds the reserve account's available balance");
  }

  return prisma.reserveLoan.create({
    data: {
      userId,
      reserveAccountId: reserveAccount.id,
      destinationAccountId: destinationAccount.id,
      principal: input.principal,
      borrowDate: input.borrowDate,
      monthlyInterestRate: input.monthlyInterestRate ?? DEFAULT_MONTHLY_INTEREST_RATE,
      description: input.description,
    },
  });
}

export async function getLoan(userId: string, loanId: string) {
  const loan = await getOwnedLoan(userId, loanId);
  const repayments = await prisma.reserveLoanRepayment.findMany({ where: { loanId }, orderBy: { repaymentDate: "asc" } });
  const state = computeLoanState(loan, repayments, new Date());
  return { loan, repayments, ...serializeState(state) };
}

export async function getOwed(userId: string, loanId: string) {
  const loan = await getOwnedLoan(userId, loanId);
  const repayments = await prisma.reserveLoanRepayment.findMany({ where: { loanId }, orderBy: { repaymentDate: "asc" } });
  const state = computeLoanState(loan, repayments, new Date());
  return { asOfDate: new Date().toISOString().slice(0, 10), ...serializeState(state) };
}

export async function listRepayments(userId: string, loanId: string) {
  await getOwnedLoan(userId, loanId);
  return prisma.reserveLoanRepayment.findMany({ where: { loanId }, orderBy: { repaymentDate: "asc" } });
}

/**
 * Applies a (possibly partial) repayment interest-first, then principal —
 * see interest.ts's applyRepayment. Runs in a transaction because the
 * allocation depends on replaying prior repayments, and flips the loan to
 * "settled" the moment outstanding principal reaches zero.
 */
export async function createRepayment(userId: string, loanId: string, input: CreateRepaymentInput) {
  return prisma.$transaction(async (tx) => {
    const loan = await tx.reserveLoan.findUnique({ where: { id: loanId } });
    if (!loan || loan.userId !== userId) throw AppError.notFound("Reserve loan not found");
    if (loan.status === "settled") throw AppError.badRequest("Loan is already settled");

    const existingRepayments = await tx.reserveLoanRepayment.findMany({
      where: { loanId },
      orderBy: { repaymentDate: "asc" },
    });

    const lastSettlementDate = existingRepayments.at(-1)?.repaymentDate ?? loan.borrowDate;
    const outstandingPrincipal = existingRepayments.reduce(
      (acc, r) => acc.minus(r.principalPortion),
      new Prisma.Decimal(loan.principal)
    );

    const amount = new Prisma.Decimal(input.amount);
    if (amount.lessThanOrEqualTo(0)) throw AppError.badRequest("amount must be greater than zero");
    if (input.repaymentDate.getTime() < lastSettlementDate.getTime()) {
      throw AppError.badRequest("repaymentDate cannot be before the loan's last settlement date");
    }

    const allocation = applyRepayment({
      outstandingPrincipal,
      lastSettlementDate,
      repaymentDate: input.repaymentDate,
      repaymentAmount: amount,
      monthlyInterestRate: new Prisma.Decimal(loan.monthlyInterestRate),
    });

    if (allocation.overpayment.greaterThan(0)) {
      throw AppError.badRequest("repayment amount exceeds total owed (principal + interest)");
    }

    const repayment = await tx.reserveLoanRepayment.create({
      data: {
        loanId,
        repaymentDate: input.repaymentDate,
        amount: input.amount,
        interestPortion: allocation.interestPortion,
        principalPortion: allocation.principalPortion,
        outstandingPrincipalAfter: allocation.outstandingPrincipalAfter,
      },
    });

    if (allocation.outstandingPrincipalAfter.isZero()) {
      await tx.reserveLoan.update({ where: { id: loanId }, data: { status: "settled" } });
    }

    return repayment;
  });
}
