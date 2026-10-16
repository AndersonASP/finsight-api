import { Prisma } from "@prisma/client";
import { addMonthsClamped } from "../../core/http/date.js";

/**
 * Months elapsed between two UTC-midnight dates, rounding up any non-zero
 * fraction of a month (any elapsed time at all counts as at least 1 month).
 * The anchor day re-clamps to the destination month's length at every step
 * from `from` directly (not chained), so e.g. borrowing on Jan 31st and
 * measuring 2 months out lands on Mar 31st, not a drifted "Feb 28 + 1 month".
 */
export function monthsElapsedRoundUp(from: Date, to: Date): number {
  if (to.getTime() <= from.getTime()) return 0;

  let months = 0;
  while (addMonthsClamped(from, months + 1).getTime() <= to.getTime()) {
    months += 1;
  }
  if (addMonthsClamped(from, months).getTime() < to.getTime()) {
    months += 1;
  }
  return Math.max(months, 1);
}

export interface RepaymentAllocation {
  interestPortion: Prisma.Decimal;
  principalPortion: Prisma.Decimal;
  outstandingPrincipalAfter: Prisma.Decimal;
  /** > 0 means repaymentAmount exceeded principal + interest actually owed. */
  overpayment: Prisma.Decimal;
}

/**
 * Allocates a repayment interest-first: interest due is computed on the
 * currently-outstanding principal for the elapsed segment since the loan's
 * last settlement (borrow date, or the previous repayment's date); whatever
 * remains after covering that interest reduces principal.
 */
export function applyRepayment(params: {
  outstandingPrincipal: Prisma.Decimal;
  lastSettlementDate: Date;
  repaymentDate: Date;
  repaymentAmount: Prisma.Decimal;
  monthlyInterestRate: Prisma.Decimal;
}): RepaymentAllocation {
  const months = monthsElapsedRoundUp(params.lastSettlementDate, params.repaymentDate);
  const interestDue = params.outstandingPrincipal.times(params.monthlyInterestRate).dividedBy(100).times(months);

  const interestPortion = Prisma.Decimal.min(params.repaymentAmount, interestDue);
  const remainderAfterInterest = params.repaymentAmount.minus(interestPortion);
  const principalPortion = Prisma.Decimal.min(remainderAfterInterest, params.outstandingPrincipal);
  const overpayment = remainderAfterInterest.minus(principalPortion);
  const outstandingPrincipalAfter = params.outstandingPrincipal.minus(principalPortion);

  return { interestPortion, principalPortion, outstandingPrincipalAfter, overpayment };
}

export interface LoanState {
  outstandingPrincipal: Prisma.Decimal;
  accruedInterest: Prisma.Decimal;
  totalOwed: Prisma.Decimal;
}

/**
 * Replays a loan's repayment history to find the current outstanding
 * principal, then accrues interest on it from the last settlement up to
 * `asOfDate` — this is the "quanto devo agora" figure, not yet realized as a
 * repayment row until the user actually pays it.
 */
export function computeLoanState(
  loan: { principal: Prisma.Decimal | string; borrowDate: Date; monthlyInterestRate: Prisma.Decimal | string },
  repayments: { repaymentDate: Date; principalPortion: Prisma.Decimal | string }[],
  asOfDate: Date
): LoanState {
  let principal = new Prisma.Decimal(loan.principal);
  let lastSettlement = loan.borrowDate;

  for (const repayment of repayments) {
    principal = principal.minus(repayment.principalPortion);
    lastSettlement = repayment.repaymentDate;
  }

  const months = monthsElapsedRoundUp(lastSettlement, asOfDate);
  const accruedInterest = principal.isZero()
    ? new Prisma.Decimal(0)
    : principal.times(loan.monthlyInterestRate).dividedBy(100).times(months);

  return { outstandingPrincipal: principal, accruedInterest, totalOwed: principal.plus(accruedInterest) };
}
