export interface Period {
  year: number;
  month: number; // 1-12
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addMonths(period: Period, n: number): Period {
  const d = new Date(Date.UTC(period.year, period.month - 1 + n, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

/**
 * Resolves which invoice cycle a purchase belongs to: if the purchase date is
 * on or before the card's closing day for that month (clamped to the month's
 * actual last day, so e.g. closingDay=31 in February means the 28th/29th),
 * it falls in the cycle closing *this* month; otherwise it rolls to next month's cycle.
 */
export function resolvePeriodForDate(card: { closingDay: number }, date: Date): Period {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const effectiveClosingDay = Math.min(card.closingDay, lastDayOfMonth(year, month));

  if (date.getUTCDate() <= effectiveClosingDay) {
    return { year, month };
  }
  return addMonths({ year, month }, 1);
}

export function computeClosingDate(card: { closingDay: number }, period: Period): Date {
  const day = Math.min(card.closingDay, lastDayOfMonth(period.year, period.month));
  return new Date(Date.UTC(period.year, period.month - 1, day));
}

/**
 * Brazilian card convention: if the due day comes numerically after the
 * closing day, the bill is due the same month it closes; otherwise it's due
 * the following month (e.g. closes the 5th, due the 12th -> same month; closes
 * the 28th, due the 5th -> next month).
 */
export function computeDueDate(card: { closingDay: number; dueDay: number }, period: Period): Date {
  const monthOffset = card.dueDay > card.closingDay ? 0 : 1;
  const targetPeriod = addMonths(period, monthOffset);
  const day = Math.min(card.dueDay, lastDayOfMonth(targetPeriod.year, targetPeriod.month));
  return new Date(Date.UTC(targetPeriod.year, targetPeriod.month - 1, day));
}
