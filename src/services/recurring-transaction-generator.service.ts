import { addDays, addMonthsClamped } from "../core/http/date.js";

export type RecurrenceInterval = "daily" | "weekly" | "biweekly" | "monthly" | "annual";

export interface RecurringOccurrence {
  occurrenceIndex: number; // 0-based
  date: Date;
}

/** Hard ceiling regardless of client input or interval — covers the worst case (10 years of "daily"). */
export const MAX_OCCURRENCE_COUNT = 3650;

/**
 * How many occurrences of `interval` fit in a ~10-year horizon. Used for
 * "para sempre": there's no job in this project to extend an open-ended
 * series later, so "forever" is implemented as a long but bounded window
 * generated eagerly at creation time, same mechanism as a finite count.
 */
export function occurrencesForTenYearHorizon(interval: RecurrenceInterval): number {
  switch (interval) {
    case "daily":
      return 3650;
    case "weekly":
      return 520;
    case "biweekly":
      return 243;
    case "monthly":
      return 120;
    case "annual":
      return 10;
  }
}

function addInterval(date: Date, interval: RecurrenceInterval, n: number): Date {
  switch (interval) {
    case "daily":
      return addDays(date, n);
    case "weekly":
      return addDays(date, n * 7);
    case "biweekly":
      return addDays(date, n * 15);
    case "monthly":
      return addMonthsClamped(date, n);
    case "annual":
      return addMonthsClamped(date, n * 12);
  }
}

/** Pure date math — generates every occurrence's date up front, same spirit as installment-generator.service.ts's generateInstallmentPlan. */
export function generateRecurringOccurrences(params: {
  startDate: Date;
  interval: RecurrenceInterval;
  occurrenceCount: number;
}): RecurringOccurrence[] {
  const occurrences: RecurringOccurrence[] = [];
  for (let index = 0; index < params.occurrenceCount; index++) {
    occurrences.push({ occurrenceIndex: index, date: addInterval(params.startDate, params.interval, index) });
  }
  return occurrences;
}
