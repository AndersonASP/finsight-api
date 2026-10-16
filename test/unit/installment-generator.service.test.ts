import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { generateInstallmentPlan } from "../../src/services/installment-generator.service.js";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

describe("generateInstallmentPlan", () => {
  it("generates all future installments, one per cycle, linked in sequence", () => {
    const plan = generateInstallmentPlan({
      card: { closingDay: 10, dueDay: 17 },
      purchaseDate: utc(2026, 3, 5),
      totalAmount: new Prisma.Decimal("300.00"),
      installmentsCount: 3,
    });

    expect(plan).toHaveLength(3);
    expect(plan.map((p) => p.sequence)).toEqual([1, 2, 3]);
    expect(plan.map((p) => p.period)).toEqual([
      { year: 2026, month: 3 },
      { year: 2026, month: 4 },
      { year: 2026, month: 5 },
    ]);
  });

  it("the sum of installments (and known charges handled upstream) equals the purchase total exactly", () => {
    const plan = generateInstallmentPlan({
      card: { closingDay: 10, dueDay: 17 },
      purchaseDate: utc(2026, 3, 5),
      totalAmount: new Prisma.Decimal("100.00"),
      installmentsCount: 3,
    });

    const sum = plan.reduce((acc, p) => acc.plus(p.amount), new Prisma.Decimal(0));
    expect(sum.toFixed(2)).toBe("100.00");
    // 100 / 3 = 33.33 repeating; the rounding remainder must land on the last installment.
    expect(plan[0].amount.toFixed(2)).toBe("33.33");
    expect(plan[1].amount.toFixed(2)).toBe("33.33");
    expect(plan[2].amount.toFixed(2)).toBe("33.34");
  });

  it("a single-installment purchase still respects the invoice cycle", () => {
    const plan = generateInstallmentPlan({
      card: { closingDay: 10, dueDay: 17 },
      purchaseDate: utc(2026, 3, 15), // after closing -> next cycle
      totalAmount: new Prisma.Decimal("50.00"),
      installmentsCount: 1,
    });

    expect(plan).toHaveLength(1);
    expect(plan[0].period).toEqual({ year: 2026, month: 4 });
    expect(plan[0].amount.toFixed(2)).toBe("50.00");
  });

  it("a manual invoice override pins the first installment's cycle", () => {
    const plan = generateInstallmentPlan({
      card: { closingDay: 10, dueDay: 17 },
      purchaseDate: utc(2026, 3, 5), // would normally resolve to March
      totalAmount: new Prisma.Decimal("200.00"),
      installmentsCount: 2,
      firstPeriodOverride: { year: 2026, month: 6 },
    });

    expect(plan.map((p) => p.period)).toEqual([
      { year: 2026, month: 6 },
      { year: 2026, month: 7 },
    ]);
  });
});
