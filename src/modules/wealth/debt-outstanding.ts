import { Prisma, type Debt } from "@prisma/client";
import { addMonthsClamped, daysInMonth } from "../../core/http/date.js";

const ZERO = new Prisma.Decimal(0);
const DAY_MS = 86_400_000;

/** An informed "valor para quitar" older than this is no longer trusted. */
export const PAYOFF_MAX_AGE_DAYS = 90;
/** A saldo variável not updated for this long is flagged as stale. */
export const VARIABLE_BALANCE_MAX_AGE_DAYS = 30;

export interface DebtOutstanding {
  /** What counts toward the patrimônio's liabilities. */
  value: Prisma.Decimal;
  source: "calculado" | "informado";
  /** Date the value refers to (today when calculated). */
  asOf: Date;
  stale: boolean;
  /** Human explanation of where `value` came from. */
  note: string;
  installmentsPaid: number | null;
  installmentsTotal: number | null;
  /** Sum of the installments still to pay (includes future interest). */
  remainingInstallmentsSum: Prisma.Decimal | null;
  nextDueDate: Date | null;
  endDate: Date | null;
  monthlyInterestCost: Prisma.Decimal | null;
}

/** Due date of installment `index` (0-based): same day every month, clamped to short months. */
export function installmentDueDate(first: Date, dueDay: number, index: number): Date {
  const month = addMonthsClamped(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1)), index);
  const year = month.getUTCFullYear();
  const monthIndex = month.getUTCMonth();
  return new Date(Date.UTC(year, monthIndex, Math.min(dueDay, daysInMonth(year, monthIndex + 1))));
}

function ageInDays(date: Date, today: Date): number {
  return Math.floor((today.getTime() - date.getTime()) / DAY_MS);
}

/**
 * How much a debt still weighs, without the user ever registering payments:
 *
 * - **parcela_fixa**: installments whose due date is before `today` count as
 *   paid. The remaining *sum of installments* overstates what it would cost
 *   to pay it off now (it includes future interest), so an informed
 *   "valor para quitar" up to 90 days old takes precedence.
 * - **saldo_variavel**: the informed balance, flagged stale after 30 days.
 */
export function getDebtOutstanding(debt: Debt, today: Date): DebtOutstanding {
  const rate = debt.monthlyInterestRate ? new Prisma.Decimal(debt.monthlyInterestRate) : null;
  const withInterest = (value: Prisma.Decimal) => (rate ? value.times(rate).dividedBy(100) : null);

  if (debt.status === "paga") {
    return {
      value: ZERO,
      source: "informado",
      asOf: debt.updatedAt,
      stale: false,
      note: "Marcada como paga",
      installmentsPaid: debt.installmentsTotal,
      installmentsTotal: debt.installmentsTotal,
      remainingInstallmentsSum: ZERO,
      nextDueDate: null,
      endDate: null,
      monthlyInterestCost: null,
    };
  }

  const isCalendarDriven =
    debt.kind === "parcela_fixa" &&
    debt.firstInstallmentDate != null &&
    debt.installmentsTotal != null &&
    debt.installmentAmount != null;

  if (isCalendarDriven) {
    const first = debt.firstInstallmentDate!;
    const total = debt.installmentsTotal!;
    const dueDay = debt.installmentDueDay ?? first.getUTCDate();
    let paid = 0;
    while (paid < total && installmentDueDate(first, dueDay, paid) < today) paid++;
    const remaining = total - paid;
    const remainingSum = new Prisma.Decimal(debt.installmentAmount!).times(remaining);
    const nextDueDate = remaining > 0 ? installmentDueDate(first, dueDay, paid) : null;
    const endDate = installmentDueDate(first, dueDay, total - 1);

    const payoffAge = debt.payoffAmountAt ? ageInDays(debt.payoffAmountAt, today) : null;
    const usePayoff = debt.payoffAmount != null && payoffAge != null && payoffAge <= PAYOFF_MAX_AGE_DAYS && remaining > 0;
    const value = usePayoff ? new Prisma.Decimal(debt.payoffAmount!) : remainingSum;

    return {
      value,
      source: usePayoff ? "informado" : "calculado",
      asOf: usePayoff ? debt.payoffAmountAt! : today,
      stale: false,
      note: usePayoff
        ? "Valor para quitar informado"
        : remaining === 0
          ? "Todas as parcelas já venceram"
          : `${remaining} parcelas restantes (soma inclui juros futuros)`,
      installmentsPaid: paid,
      installmentsTotal: total,
      remainingInstallmentsSum: remainingSum,
      nextDueDate,
      endDate,
      monthlyInterestCost: withInterest(value),
    };
  }

  const value = new Prisma.Decimal(debt.currentBalance);
  const asOf = debt.balanceUpdatedAt ?? debt.updatedAt;
  return {
    value,
    source: "informado",
    asOf,
    stale: ageInDays(asOf, today) > VARIABLE_BALANCE_MAX_AGE_DAYS,
    note: "Saldo informado",
    installmentsPaid: null,
    installmentsTotal: null,
    remainingInstallmentsSum: null,
    nextDueDate: null,
    endDate: null,
    monthlyInterestCost: withInterest(value),
  };
}
