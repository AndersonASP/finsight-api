import { Prisma } from "@prisma/client";
import { startOfUtcDay } from "../../core/http/date.js";
import type { Baseline, BaselineMonth } from "./purchase-impact.js";
import { monthIndexOf } from "./purchase-impact.js";
import { computeMonthCapacity, getReserveStatus, SAFETY_DAYS_OF_DIARIO, suggestDestination } from "./savings-capacity.service.js";

/** Never project further than this, whatever the installment count. */
export const MAX_SIMULATED_MONTHS = 24;

const mesOf = (index: number) => `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;

/**
 * Loads the real projection (Saldos + "dá para guardar") for months
 * `fromIndex`..`toIndex` (year * 12 + month0), capped at MAX_SIMULATED_MONTHS
 * from the current month, plus what decides how strict the reserve guardian
 * is: the método's destination order (reserve up to the user's target →
 * expensive debt → invest) — anything but "investir" means the reserve (or
 * the debt) still comes first.
 */
export async function loadBaseline(userId: string, fromIndex: number, toIndex: number) {
  const today = startOfUtcDay(new Date());
  const currentIndex = monthIndexOf(today);
  const last = Math.min(toIndex, currentIndex + MAX_SIMULATED_MONTHS - 1);
  const indexes: number[] = [];
  for (let i = Math.min(fromIndex, last); i <= last; i++) indexes.push(i);

  const [capacities, destino, reserve] = await Promise.all([
    Promise.all(indexes.map((i) => computeMonthCapacity(userId, Math.floor(i / 12), (i % 12) + 1))),
    suggestDestination(userId, today),
    getReserveStatus(userId, today),
  ]);

  const months: BaselineMonth[] = capacities.map((c, k) => ({
    index: indexes[k],
    mes: mesOf(indexes[k]),
    isPast: c.isPast,
    days: c.days.map((d) => {
      const date = d.date as string;
      return { date, time: new Date(`${date}T00:00:00.000Z`).getTime(), saldo: new Prisma.Decimal(d.saldo) };
    }),
    entradas: c.entradas,
    economiaFeita: c.economiaFeita,
    sobraProjetada: c.sobraProjetada,
    folga: c.folga,
    totalPossivel: c.totalPossivel,
    metaValor: c.metaValor,
  }));

  const current = capacities[indexes.indexOf(currentIndex)] ?? capacities[0];
  const baseline: Baseline = {
    today,
    months,
    metaPercent: current.metaPercent,
    strict: destino.kind !== "investir",
  };
  return {
    baseline,
    destino,
    reserve,
    /** Average diário per day this month (the folga is a week of it). */
    diarioPorDia: current.folga.dividedBy(SAFETY_DAYS_OF_DIARIO),
  };
}

export type LoadedBaseline = Awaited<ReturnType<typeof loadBaseline>>;
