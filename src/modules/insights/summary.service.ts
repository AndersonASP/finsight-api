import { Prisma } from "@prisma/client";
import { startOfUtcDay } from "../../core/http/date.js";
import { listBills } from "../bills/bills.service.js";
import { getDailyBalance, getTotalBalance } from "../reports/reports.service.js";
import { getSavingsCapacity } from "./savings-capacity.service.js";

const DAY_MS = 86_400_000;
/** How far ahead "próximas contas" looks. */
export const SUMMARY_BILLS_DAYS = 14;

/** Same "green" as the Saldos table's color tiers (SaldoTiers.positiveThreshold). */
export const GREEN_THRESHOLD = new Prisma.Decimal(500);
/** How far ahead the "mar vermelho" looks. */
export const RED_SEA_MONTHS = 12;

/**
 * "Mar vermelho": how much new money would have to come in *today* to keep
 * the projected saldo green (≥ R$ 500) every day ahead. The saldo is a running
 * balance, so money in today lifts every later day by the same amount —
 * the answer is the gap between the worst projected day and the green line.
 * Per month, `precisaAteOMes` is that amount counting only up to that month.
 */
export async function getRedSea(userId: string, today: Date, months = RED_SEA_MONTHS) {
  const todayIso = today.toISOString().slice(0, 10);
  const start = today.getUTCFullYear() * 12 + today.getUTCMonth();
  const series = await Promise.all(
    Array.from({ length: months }, (_, i) => {
      const index = start + i;
      return getDailyBalance(userId, Math.floor(index / 12), (index % 12) + 1);
    })
  );

  let worst: { date: string; value: Prisma.Decimal } | null = null;
  let neededSoFar = new Prisma.Decimal(0);
  let firstRedMonth: string | null = null;
  const perMonth = series.map((days, i) => {
    const index = start + i;
    const mes = `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
    const ahead = days.filter((d) => d.date >= todayIso);
    let lowest: { date: string; value: Prisma.Decimal } | null = null;
    for (const d of ahead) {
      const value = new Prisma.Decimal(d.saldo);
      if (!lowest || value.lessThan(lowest.value)) lowest = { date: d.date, value };
    }
    if (lowest && (!worst || lowest.value.lessThan(worst.value))) worst = lowest;
    const gap = lowest ? GREEN_THRESHOLD.minus(lowest.value) : new Prisma.Decimal(0);
    if (gap.greaterThan(neededSoFar)) neededSoFar = gap;
    if (!firstRedMonth && lowest && lowest.value.isNegative()) firstRedMonth = mes;
    return {
      mes,
      menorSaldo: lowest ? lowest.value.toFixed(2) : null,
      precisaAteOMes: neededSoFar.toFixed(2),
    };
  });

  const worstPoint = worst as { date: string; value: Prisma.Decimal } | null;
  return {
    limiteVerde: GREEN_THRESHOLD.toFixed(2),
    horizonteMeses: months,
    precisaEntrar: neededSoFar.toFixed(2),
    paraSairDoNegativo: worstPoint && worstPoint.value.isNegative() ? worstPoint.value.negated().toFixed(2) : "0.00",
    piorDia: worstPoint ? { date: worstPoint.date, value: worstPoint.value.toFixed(2) } : null,
    primeiroMesNoVermelho: firstRedMonth,
    meses: perMonth,
  };
}

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

  const [saldoHoje, days, capacity, bills, marVermelho] = await Promise.all([
    getTotalBalance(userId, today),
    getDailyBalance(userId, year, month),
    getSavingsCapacity(userId, year, month),
    listBills(userId, today, new Date(today.getTime() + SUMMARY_BILLS_DAYS * DAY_MS)),
    getRedSea(userId, today),
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
    marVermelho,
    proximasContas: bills
      .filter((b) => !b.paid)
      .slice(0, 3)
      .map((b) => ({ description: b.description, amount: b.amount.toFixed(2), dueDate: b.dueDate.toISOString().slice(0, 10) })),
  };
}
