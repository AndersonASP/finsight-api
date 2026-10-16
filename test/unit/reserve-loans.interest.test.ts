import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { applyRepayment, computeLoanState, monthsElapsedRoundUp } from "../../src/modules/reserve-loans/interest.js";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
const dec = (v: string) => new Prisma.Decimal(v);

describe("monthsElapsedRoundUp", () => {
  it("is zero for the same day (no interest on same-day settlement)", () => {
    expect(monthsElapsedRoundUp(utc(2026, 10, 15), utc(2026, 10, 15))).toBe(0);
  });

  it("rounds any sub-month fraction up to 1 month", () => {
    expect(monthsElapsedRoundUp(utc(2026, 10, 15), utc(2026, 10, 16))).toBe(1);
    expect(monthsElapsedRoundUp(utc(2026, 10, 15), utc(2026, 11, 10))).toBe(1); // less than a full month
  });

  it("counts an exact calendar-month anniversary with no rounding", () => {
    expect(monthsElapsedRoundUp(utc(2026, 10, 15), utc(2026, 11, 15))).toBe(1);
    expect(monthsElapsedRoundUp(utc(2026, 10, 15), utc(2026, 12, 15))).toBe(2);
  });

  it("rounds a trailing fraction past a multi-month anniversary up to the next month", () => {
    // Oct15->Nov15 (1) ->Dec15 (2) -> 5 more days into Dec20 rounds up to 3.
    expect(monthsElapsedRoundUp(utc(2026, 10, 15), utc(2026, 12, 20))).toBe(3);
  });

  it("clamps a day-31 anchor to the end of a shorter month, without drifting on later months", () => {
    // Jan 31 -> Feb 28 (2026 is not a leap year) is exactly 1 month (clamped anchor).
    expect(monthsElapsedRoundUp(utc(2026, 1, 31), utc(2026, 2, 28))).toBe(1);
    // Jan 31 -> Mar 31 is exactly 2 months (the anchor re-clamps per step from
    // the original date, so month 2 is Mar 31, not "Feb 28 + 1 calendar month").
    expect(monthsElapsedRoundUp(utc(2026, 1, 31), utc(2026, 3, 31))).toBe(2);
    // Jan 31 -> Mar 2 is just past the 1-month mark (Feb 28) but short of the
    // 2-month mark (Mar 31), so it rounds up to 2.
    expect(monthsElapsedRoundUp(utc(2026, 1, 31), utc(2026, 3, 2))).toBe(2);
  });
});

describe("applyRepayment", () => {
  it("allocates interest first, then principal, for a partial payment", () => {
    // R$1000 borrowed, 10%/month, repaid 1 month later with R$300 (less than
    // the R$100 interest + R$1000 principal owed).
    const allocation = applyRepayment({
      outstandingPrincipal: dec("1000.00"),
      lastSettlementDate: utc(2026, 10, 1),
      repaymentDate: utc(2026, 11, 1),
      repaymentAmount: dec("300.00"),
      monthlyInterestRate: dec("10"),
    });

    expect(allocation.interestPortion.toFixed(2)).toBe("100.00");
    expect(allocation.principalPortion.toFixed(2)).toBe("200.00");
    expect(allocation.outstandingPrincipalAfter.toFixed(2)).toBe("800.00");
    expect(allocation.overpayment.toFixed(2)).toBe("0.00");
  });

  it("pays off interest and principal fully with no overpayment left over", () => {
    const allocation = applyRepayment({
      outstandingPrincipal: dec("1000.00"),
      lastSettlementDate: utc(2026, 10, 1),
      repaymentDate: utc(2026, 11, 1),
      repaymentAmount: dec("1100.00"), // exactly principal + 1 month of interest
      monthlyInterestRate: dec("10"),
    });

    expect(allocation.interestPortion.toFixed(2)).toBe("100.00");
    expect(allocation.principalPortion.toFixed(2)).toBe("1000.00");
    expect(allocation.outstandingPrincipalAfter.toFixed(2)).toBe("0.00");
    expect(allocation.overpayment.toFixed(2)).toBe("0.00");
  });

  it("flags an overpayment beyond what's actually owed", () => {
    const allocation = applyRepayment({
      outstandingPrincipal: dec("1000.00"),
      lastSettlementDate: utc(2026, 10, 1),
      repaymentDate: utc(2026, 11, 1),
      repaymentAmount: dec("1200.00"), // 100 more than the 1100 owed
      monthlyInterestRate: dec("10"),
    });

    expect(allocation.outstandingPrincipalAfter.toFixed(2)).toBe("0.00");
    expect(allocation.overpayment.toFixed(2)).toBe("100.00");
  });
});

describe("computeLoanState", () => {
  it("accrues interest on the remaining principal after a prior partial repayment", () => {
    const loan = { principal: dec("1000.00"), borrowDate: utc(2026, 10, 1), monthlyInterestRate: dec("10") };
    // One month in, a partial repayment reduces principal to 800 (see the
    // "allocates interest first" case above).
    const repayments = [{ repaymentDate: utc(2026, 11, 1), principalPortion: dec("200.00") }];

    // A further month later, interest accrues on the reduced 800 principal,
    // not the original 1000.
    const state = computeLoanState(loan, repayments, utc(2026, 12, 1));

    expect(state.outstandingPrincipal.toFixed(2)).toBe("800.00");
    expect(state.accruedInterest.toFixed(2)).toBe("80.00");
    expect(state.totalOwed.toFixed(2)).toBe("880.00");
  });

  it("owes nothing once principal is fully repaid", () => {
    const loan = { principal: dec("1000.00"), borrowDate: utc(2026, 10, 1), monthlyInterestRate: dec("10") };
    const repayments = [{ repaymentDate: utc(2026, 11, 1), principalPortion: dec("1000.00") }];

    const state = computeLoanState(loan, repayments, utc(2027, 1, 1));

    expect(state.outstandingPrincipal.toFixed(2)).toBe("0.00");
    expect(state.accruedInterest.toFixed(2)).toBe("0.00");
  });
});
