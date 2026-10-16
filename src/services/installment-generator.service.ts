import { toCents, fromCents, splitIntoInstallments } from "../core/money/money.js";
import { addMonths, computeDueDate, resolvePeriodForDate, type Period } from "./invoice-cycle.service.js";
import { Prisma } from "@prisma/client";

export interface InstallmentPlanItem {
  sequence: number;
  amount: Prisma.Decimal;
  period: Period;
  dueDate: Date;
}

/**
 * Splits a purchase total into `installmentsCount` installments (remainder
 * cents go to the last one, so the sum always equals the original total
 * exactly) and assigns each to its invoice cycle: the first installment uses
 * the normal cycle resolution (or `firstPeriod` when overridden manually),
 * and each subsequent one rolls forward one cycle per installment.
 */
export function generateInstallmentPlan(params: {
  card: { closingDay: number; dueDay: number };
  purchaseDate: Date;
  totalAmount: Prisma.Decimal;
  installmentsCount: number;
  firstPeriodOverride?: Period;
}): InstallmentPlanItem[] {
  const { card, purchaseDate, totalAmount, installmentsCount, firstPeriodOverride } = params;

  const totalCents = toCents(totalAmount);
  const centsPerInstallment = splitIntoInstallments(totalCents, installmentsCount);
  const firstPeriod = firstPeriodOverride ?? resolvePeriodForDate(card, purchaseDate);

  return centsPerInstallment.map((cents, index) => {
    const period = index === 0 ? firstPeriod : addMonths(firstPeriod, index);
    return {
      sequence: index + 1,
      amount: fromCents(cents),
      period,
      dueDate: computeDueDate(card, period),
    };
  });
}
