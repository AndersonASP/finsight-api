import { Prisma } from "@prisma/client";

/** Converts a monetary value (Decimal, string, or number) to an integer number of cents. */
export function toCents(value: Prisma.Decimal | string | number): number {
  const str = typeof value === "object" ? value.toFixed(2) : String(value);
  const [whole, fraction = "0"] = str.split(".");
  const sign = whole.startsWith("-") ? -1 : 1;
  const wholeAbs = whole.replace("-", "");
  const cents = Number(wholeAbs) * 100 + Number(fraction.padEnd(2, "0").slice(0, 2));
  return sign * cents;
}

/** Converts an integer number of cents back to a Decimal with 2 fraction digits. */
export function fromCents(cents: number): Prisma.Decimal {
  return new Prisma.Decimal(cents).dividedBy(100);
}

/**
 * Splits a total (in cents) into `count` installments, distributing the rounding
 * remainder into the last installment so the sum always equals the original total.
 */
export function splitIntoInstallments(totalCents: number, count: number): number[] {
  if (count < 1) throw new Error("count must be >= 1");
  const base = Math.floor(totalCents / count);
  const remainder = totalCents - base * count;
  return Array.from({ length: count }, (_, i) => (i === count - 1 ? base + remainder : base));
}
