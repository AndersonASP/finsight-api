import { describe, expect, it } from "vitest";
import {
  generateRecurringOccurrences,
  occurrencesForTenYearHorizon,
} from "../../src/services/recurring-transaction-generator.service.js";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

describe("generateRecurringOccurrences", () => {
  it("daily: one occurrence per day, starting at the given date", () => {
    const occurrences = generateRecurringOccurrences({ startDate: utc(2026, 10, 1), interval: "daily", occurrenceCount: 3 });

    expect(occurrences.map((o) => o.occurrenceIndex)).toEqual([0, 1, 2]);
    expect(occurrences.map((o) => o.date)).toEqual([utc(2026, 10, 1), utc(2026, 10, 2), utc(2026, 10, 3)]);
  });

  it("weekly: 7 days apart", () => {
    const occurrences = generateRecurringOccurrences({ startDate: utc(2026, 10, 1), interval: "weekly", occurrenceCount: 3 });
    expect(occurrences.map((o) => o.date)).toEqual([utc(2026, 10, 1), utc(2026, 10, 8), utc(2026, 10, 15)]);
  });

  it("biweekly (quinzenal): 15 days apart", () => {
    const occurrences = generateRecurringOccurrences({ startDate: utc(2026, 10, 1), interval: "biweekly", occurrenceCount: 3 });
    expect(occurrences.map((o) => o.date)).toEqual([utc(2026, 10, 1), utc(2026, 10, 16), utc(2026, 10, 31)]);
  });

  it("monthly: one calendar month apart, clamped on short months (day 31 -> Feb 28)", () => {
    const occurrences = generateRecurringOccurrences({ startDate: utc(2026, 1, 31), interval: "monthly", occurrenceCount: 3 });
    expect(occurrences.map((o) => o.date)).toEqual([utc(2026, 1, 31), utc(2026, 2, 28), utc(2026, 3, 31)]);
  });

  it("annual: 12 months apart (one calendar year)", () => {
    const occurrences = generateRecurringOccurrences({ startDate: utc(2026, 10, 5), interval: "annual", occurrenceCount: 3 });
    expect(occurrences.map((o) => o.date)).toEqual([utc(2026, 10, 5), utc(2027, 10, 5), utc(2028, 10, 5)]);
  });

  it("generates exactly occurrenceCount rows, even for a large 'para sempre' window", () => {
    const occurrences = generateRecurringOccurrences({ startDate: utc(2026, 1, 1), interval: "daily", occurrenceCount: 3650 });
    expect(occurrences).toHaveLength(3650);
    expect(occurrences[3649].occurrenceIndex).toBe(3649);
  });
});

describe("occurrencesForTenYearHorizon", () => {
  it("picks an occurrence count that covers roughly 10 years for each interval", () => {
    expect(occurrencesForTenYearHorizon("daily")).toBe(3650);
    expect(occurrencesForTenYearHorizon("weekly")).toBe(520);
    expect(occurrencesForTenYearHorizon("biweekly")).toBe(243);
    expect(occurrencesForTenYearHorizon("monthly")).toBe(120);
    expect(occurrencesForTenYearHorizon("annual")).toBe(10);
  });
});
