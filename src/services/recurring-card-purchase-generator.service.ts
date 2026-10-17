import { addMonthsClamped } from "../core/http/date.js";

export interface RecurringCardPurchaseOccurrence {
  occurrenceIndex: number; // 0-based
  purchaseDate: Date;
}

/** A card subscription is always monthly — same 10-year horizon as occurrencesForTenYearHorizon("monthly"). */
export const OPEN_ENDED_OCCURRENCE_COUNT = 120;

/** Hard ceiling regardless of client input — mirrors MAX_OCCURRENCE_COUNT's role for recurring transactions. */
export const MAX_OCCURRENCE_COUNT = 120;

/** Pure date math — generates every occurrence's purchase date up front, same spirit as generateRecurringOccurrences. */
export function generateRecurringCardPurchaseOccurrences(params: {
  startDate: Date;
  occurrenceCount: number;
}): RecurringCardPurchaseOccurrence[] {
  const occurrences: RecurringCardPurchaseOccurrence[] = [];
  for (let index = 0; index < params.occurrenceCount; index++) {
    occurrences.push({ occurrenceIndex: index, purchaseDate: addMonthsClamped(params.startDate, index) });
  }
  return occurrences;
}
