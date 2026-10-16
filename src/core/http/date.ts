import { AppError } from "./errors.js";

/** Parses a `YYYY-MM-DD` string into a UTC midnight Date, matching how Prisma stores `@db.Date` columns. */
export function parseDateParam(value: string, fieldName = "date"): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw AppError.badRequest(`${fieldName} must be in YYYY-MM-DD format`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw AppError.badRequest(`${fieldName} is not a valid date`);
  }
  return date;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Adds `n` whole days to a UTC-midnight date. */
export function addDays(date: Date, n: number): Date {
  return new Date(date.getTime() + n * 86_400_000);
}

/** Truncates a timestamp down to UTC midnight of the same calendar day. */
export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Adds `n` months to a UTC-midnight date, clamping the day-of-month to the
 * destination month's length (e.g. Jan 31st + 1 month -> Feb 28th).
 */
export function addMonthsClamped(date: Date, n: number): Date {
  const targetMonthIndex = date.getUTCMonth() + n;
  const year = date.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const month = ((targetMonthIndex % 12) + 12) % 12; // 0-based, always positive
  const day = Math.min(date.getUTCDate(), daysInMonth(year, month + 1));
  return new Date(Date.UTC(year, month, day));
}
