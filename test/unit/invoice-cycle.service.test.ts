import { describe, expect, it } from "vitest";
import { computeDueDate, resolvePeriodForDate } from "../../src/services/invoice-cycle.service.js";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

describe("resolvePeriodForDate", () => {
  it("a purchase in the open cycle (on or before closing day) lands in this month's invoice", () => {
    const card = { closingDay: 10 };
    expect(resolvePeriodForDate(card, utc(2026, 3, 10))).toEqual({ year: 2026, month: 3 });
    expect(resolvePeriodForDate(card, utc(2026, 3, 1))).toEqual({ year: 2026, month: 3 });
  });

  it("a purchase after closing rolls into the next eligible cycle", () => {
    const card = { closingDay: 10 };
    expect(resolvePeriodForDate(card, utc(2026, 3, 11))).toEqual({ year: 2026, month: 4 });
    expect(resolvePeriodForDate(card, utc(2026, 12, 25))).toEqual({ year: 2027, month: 1 }); // year rollover
  });

  it("clamps closingDay=31 to the actual last day of short months", () => {
    const card = { closingDay: 31 };
    // Feb 2026 has 28 days; the 28th is the effective closing day.
    expect(resolvePeriodForDate(card, utc(2026, 2, 28))).toEqual({ year: 2026, month: 2 });
  });
});

describe("computeDueDate", () => {
  it("due date falls in the same month as closing when dueDay > closingDay", () => {
    const due = computeDueDate({ closingDay: 5, dueDay: 12 }, { year: 2026, month: 3 });
    expect(due).toEqual(utc(2026, 3, 12));
  });

  it("due date rolls to the next month when dueDay <= closingDay", () => {
    const due = computeDueDate({ closingDay: 28, dueDay: 5 }, { year: 2026, month: 3 });
    expect(due).toEqual(utc(2026, 4, 5));
  });
});
