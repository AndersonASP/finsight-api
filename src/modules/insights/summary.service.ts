import { Prisma } from "@prisma/client";
import { startOfUtcDay } from "../../core/http/date.js";
import { listBills } from "../bills/bills.service.js";
import { getDailyBalance, getTotalBalance } from "../reports/reports.service.js";
import { getSavingsCapacity } from "./savings-capacity.service.js";

const DAY_MS = 86_400_000;
/** How far ahead "próximas contas" looks. */
export const SUMMARY_BILLS_DAYS = 14;

/**
 * The few numbers that fit on a home/lock screen widget: saldo now, where the
 * month ends, the tightest point ahead, what can be saved and the next bills
 * still unchecked. Same figures the app shows elsewhere.
 */
export async function getSummary(userId: string, now = new Date()) {
  const today = startOfUtcDay(now);
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() + 1;
  const todayIso = today.toISOString().slice(0, 10);

  const [saldoHoje, days, capacity, bills] = await Promise.all([
    getTotalBalance(userId, today),
    getDailyBalance(userId, year, month),
    getSavingsCapacity(userId, year, month),
    listBills(userId, today, new Date(today.getTime() + SUMMARY_BILLS_DAYS * DAY_MS)),
  ]);

  const ahead = days.filter((d) => d.date >= todayIso);
  const lowest = ahead.reduce<(typeof ahead)[number] | null>(
    (min, d) => (!min || Number(d.saldo) < Number(min.saldo) ? d : min),
    null
  );

  return {
    asOf: now.toISOString(),
    saldoHoje: new Prisma.Decimal(saldoHoje).toFixed(2),
    saldoFimDoMes: days.length ? days[days.length - 1].saldo : null,
    menorSaldo: lowest ? { date: lowest.date, value: lowest.saldo } : null,
    podeGuardar: capacity.podeGuardarAgora,
    proximasContas: bills
      .filter((b) => !b.paid)
      .slice(0, 3)
      .map((b) => ({ description: b.description, amount: b.amount.toFixed(2), dueDate: b.dueDate.toISOString().slice(0, 10) })),
  };
}
