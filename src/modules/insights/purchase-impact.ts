import { Prisma } from "@prisma/client";

/**
 * Pure part of the "E se?" simulation: overlays hypothetical cash outflows
 * on an already-loaded projection (see purchase-baseline.ts) and judges the
 * result. No database access here, so the rules are unit-testable and one
 * baseline serves every payment option being compared.
 */

const ZERO = new Prisma.Decimal(0);

/** A purchase counts as "pertinente" (the reserve guardian applies) from this share of the month's entradas. */
export const PERTINENT_PURCHASE_PERCENT = 10;

export interface CashOut {
  date: Date;
  amount: Prisma.Decimal;
}

export interface BaselineDay {
  date: string;
  time: number;
  saldo: Prisma.Decimal;
}

/** One month of the real projection, as getSavingsCapacity sees it. */
export interface BaselineMonth {
  /** year * 12 + (month - 1) */
  index: number;
  /** YYYY-MM */
  mes: string;
  isPast: boolean;
  days: BaselineDay[];
  entradas: Prisma.Decimal;
  economiaFeita: Prisma.Decimal;
  sobraProjetada: Prisma.Decimal;
  /** A week of diário kept untouched. */
  folga: Prisma.Decimal;
  /** Economia feita + what can still be saved (the "dá para guardar" total). */
  totalPossivel: Prisma.Decimal;
  metaValor: Prisma.Decimal;
}

export interface Baseline {
  today: Date;
  months: BaselineMonth[];
  metaPercent: Prisma.Decimal;
  /** Reserve incomplete or expensive debt pending: breaking the savings target is a "fura a reserva". */
  strict: boolean;
}

export type Verdict = "cabe" | "aperta" | "fura_reserva" | "nao_cabe";

export const VERDICT_SEVERITY: Record<Verdict, number> = { cabe: 0, aperta: 1, fura_reserva: 2, nao_cabe: 3 };

export interface MonthImpact {
  mes: string;
  pagaNoMes: Prisma.Decimal;
  menorSaldoAntes: { date: string; value: Prisma.Decimal } | null;
  menorSaldoDepois: { date: string; value: Prisma.Decimal } | null;
  saldoFimDoMesAntes: Prisma.Decimal;
  saldoFimDoMesDepois: Prisma.Decimal;
  guardaAntes: Prisma.Decimal;
  guardaDepois: Prisma.Decimal;
  metaValor: Prisma.Decimal;
  entradas: Prisma.Decimal;
  folga: Prisma.Decimal;
  economiaFeita: Prisma.Decimal;
  jaNegativoSemACompra: boolean;
  /** Lowest saldo on the days the purchase has already been paid, and the saldo that day without it. */
  menorSaldoPago: { date: string; value: Prisma.Decimal; antes: Prisma.Decimal } | null;
  ficaNegativoComACompra: boolean;
  /** Lowest saldo with the purchase dips under a week of diário. */
  aperta: boolean;
  /** The purchase pushes this month's savings under the target. */
  furaMeta: boolean;
}

export interface Impact {
  verdict: Verdict;
  pertinent: boolean;
  months: MonthImpact[];
  /** Lowest saldo once the purchase has been paid (any month), and that day's saldo without it. */
  lowestAfter: { date: string; value: Prisma.Decimal; antes: Prisma.Decimal } | null;
}

export const monthIndexOf = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();

const median = (values: Prisma.Decimal[]) => {
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? ZERO;
};

/** Months used for the "typical month": the next full ones (the current one is partly past). */
const TYPICAL_MONTHS = 3;

const min = (a: Prisma.Decimal, b: Prisma.Decimal) => (a.lessThan(b) ? a : b);
const max = (a: Prisma.Decimal, b: Prisma.Decimal) => (a.greaterThan(b) ? a : b);

/**
 * Entradas the pertinence threshold is measured against: a typical month —
 * the median of the next full months — so a one-off entrada this month
 * doesn't make a big purchase look small. Falls back to the first month
 * that has any.
 */
export function referenceEntradas(baseline: Baseline) {
  const currentIndex = monthIndexOf(baseline.today);
  const next = baseline.months.filter((m) => m.index > currentIndex).slice(0, TYPICAL_MONTHS);
  const typical = median(next.map((m) => m.entradas));
  if (typical.greaterThan(0)) return typical;
  return baseline.months.find((m) => m.entradas.greaterThan(0))?.entradas ?? ZERO;
}

export function isPertinent(baseline: Baseline, amount: Prisma.Decimal) {
  const entradas = referenceEntradas(baseline);
  if (entradas.isZero()) return true;
  return !amount.lessThan(entradas.times(PERTINENT_PURCHASE_PERCENT).dividedBy(100));
}

/**
 * Overlays `cashOuts` on the baseline from the month of `fromDate` to the
 * last month that pays something (or `untilIndex`, so options being compared
 * cover the same months), recomputing per month:
 *  - the lowest saldo from today on (past days can't change);
 *  - how much can still be saved: economia feita + max(0, min(sobra − paid
 *    this month, lowest saldo − folga)), the same rule as getSavingsCapacity.
 * Verdict, most severe first (saldo judged only on days the purchase has
 * already been paid): saldo negative → nao_cabe; a pertinent purchase
 * that pushes savings under the target → fura_reserva (strict) or aperta;
 * saldo under the folga → aperta; else cabe.
 */
export function evaluateCashOuts(
  baseline: Baseline,
  cashOuts: CashOut[],
  opts: { fromDate: Date; pertinent: boolean; untilIndex?: number }
): Impact {
  const todayTime = baseline.today.getTime();
  const firstIndex = monthIndexOf(opts.fromDate);
  const lastIndex = Math.max(firstIndex, opts.untilIndex ?? 0, ...cashOuts.map((c) => monthIndexOf(c.date)));
  const months: MonthImpact[] = [];

  for (const base of baseline.months) {
    if (base.index < firstIndex || base.index > lastIndex) continue;
    let lowestBefore: MonthImpact["menorSaldoAntes"] = null;
    let lowestAfter: MonthImpact["menorSaldoDepois"] = null;
    let endBefore = ZERO;
    let endAfter = ZERO;
    // Lowest saldo on the days the purchase has already been paid: a dip
    // before the money leaves (e.g. negative today, salary tomorrow, card
    // due next month) isn't caused by the purchase and doesn't judge it.
    let lowestPaid: MonthImpact["menorSaldoPago"] = null;
    for (const day of base.days) {
      const paidSoFar = cashOuts.filter((c) => c.date.getTime() <= day.time).reduce((s, c) => s.plus(c.amount), ZERO);
      const after = day.saldo.minus(paidSoFar);
      endBefore = day.saldo;
      endAfter = after;
      if (day.time < todayTime) continue; // the past can't change
      if (!lowestBefore || day.saldo.lessThan(lowestBefore.value)) lowestBefore = { date: day.date, value: day.saldo };
      if (!lowestAfter || after.lessThan(lowestAfter.value)) lowestAfter = { date: day.date, value: after };
      if (paidSoFar.greaterThan(0) && (!lowestPaid || after.lessThan(lowestPaid.value))) {
        lowestPaid = { date: day.date, value: after, antes: day.saldo };
      }
    }

    const pagaNoMes = cashOuts.filter((c) => monthIndexOf(c.date) === base.index).reduce((s, c) => s.plus(c.amount), ZERO);
    let guardaDepois = base.totalPossivel;
    if (!base.isPast) {
      const sobra = base.sobraProjetada.minus(pagaNoMes);
      const ceiling = lowestAfter ? min(sobra, lowestAfter.value.minus(base.folga)) : sobra;
      guardaDepois = base.economiaFeita.plus(max(ZERO, ceiling));
    }
    // Under the target because of the purchase, or paying it in a month that already doesn't reach the target.
    const furaMeta = guardaDepois.lessThan(base.metaValor) && (guardaDepois.lessThan(base.totalPossivel) || pagaNoMes.greaterThan(0));

    months.push({
      mes: base.mes,
      pagaNoMes,
      menorSaldoAntes: lowestBefore,
      menorSaldoDepois: lowestAfter,
      saldoFimDoMesAntes: endBefore,
      saldoFimDoMesDepois: endAfter,
      guardaAntes: base.totalPossivel,
      guardaDepois,
      metaValor: base.metaValor,
      entradas: base.entradas,
      folga: base.folga,
      economiaFeita: base.economiaFeita,
      jaNegativoSemACompra: lowestBefore ? lowestBefore.value.isNegative() : false,
      menorSaldoPago: lowestPaid,
      ficaNegativoComACompra: lowestPaid ? lowestPaid.value.isNegative() : false,
      aperta: lowestPaid ? lowestPaid.value.lessThan(base.folga) : false,
      furaMeta,
    });
  }

  let verdict: Verdict = "cabe";
  if (months.some((m) => m.ficaNegativoComACompra)) verdict = "nao_cabe";
  else if (opts.pertinent && months.some((m) => m.furaMeta)) verdict = baseline.strict ? "fura_reserva" : "aperta";
  else if (months.some((m) => m.aperta)) verdict = "aperta";

  const lowestAfter = months.reduce<Impact["lowestAfter"]>(
    (acc, m) => (m.menorSaldoPago && (!acc || m.menorSaldoPago.value.lessThan(acc.value)) ? m.menorSaldoPago : acc),
    null
  );
  return { verdict, pertinent: opts.pertinent, months, lowestAfter };
}

/**
 * "Junte para ela": what's left above the savings target month by month
 * (from the current month on), accumulated until it covers `amount`.
 * Null when 12 months of margin don't get there.
 */
export function saveUpPlan(baseline: Baseline, amount: Prisma.Decimal, horizonMonths = 12) {
  const currentIndex = monthIndexOf(baseline.today);
  let accumulated = ZERO;
  let count = 0;
  for (const m of baseline.months) {
    if (m.index < currentIndex) continue;
    if (count >= horizonMonths) break;
    count++;
    accumulated = accumulated.plus(max(ZERO, m.totalPossivel.minus(m.metaValor)));
    if (!accumulated.lessThan(amount)) {
      return { mes: m.mes, meses: count, porMes: amount.dividedBy(count).toDecimalPlaces(2, Prisma.Decimal.ROUND_UP) };
    }
  }
  return null;
}

export interface PurchasePlan {
  /** Saldo already negative this month without the purchase: what's missing to get back to zero, and when. */
  buraco: { valor: Prisma.Decimal; data: string } | null;
  /** Spending to cut every month so the month stops closing short and saves the target. */
  ajusteMensal: Prisma.Decimal;
  /** Typical monthly result without the purchase (negative = spends more than comes in) and the target. */
  sobraTipica: Prisma.Decimal;
  metaTipica: Prisma.Decimal;
  /** How the purchase is spread: installments on a card, or saving up before paying by Pix. */
  compra: { porMes: Prisma.Decimal; meses: number; jaSobra: Prisma.Decimal };
  /** ajusteMensal + what the purchase still needs per month after the margin above the target. */
  porMes: Prisma.Decimal;
}

/**
 * "O que você precisa para comprar": deterministic monthly plan for buying
 * without the saldo going negative and without saving under the target —
 * the hole the projection already has this month, the monthly adjustment
 * for a typical month (median of the next full months) to stop closing
 * short and save the target, and the purchase spread over `meses` months
 * (minus what's already left above the target). Null when nothing is
 * missing (the purchase only needs another method or date — see the paths).
 */
export function purchasePlan(baseline: Baseline, spread: { porMes: Prisma.Decimal; meses: number }): PurchasePlan | null {
  const currentIndex = monthIndexOf(baseline.today);
  const todayTime = baseline.today.getTime();
  const current = baseline.months.find((m) => m.index === currentIndex);

  let buraco: PurchasePlan["buraco"] = null;
  for (const day of current?.days ?? []) {
    if (day.time < todayTime || !day.saldo.isNegative()) continue;
    if (!buraco || day.saldo.negated().greaterThan(buraco.valor)) buraco = { valor: day.saldo.negated(), data: day.date };
  }

  const typical = baseline.months.filter((m) => m.index > currentIndex).slice(0, TYPICAL_MONTHS);
  if (typical.length === 0 && current) typical.push(current);
  const sobraTipica = median(typical.map((m) => m.sobraProjetada));
  const metaTipica = median(typical.map((m) => m.metaValor));
  // Rounded parts first, so the sentence's numbers add up ("sai 1.526 a mais" + "meta 1.349" = 2.875).
  const whole = (v: Prisma.Decimal) => v.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
  const ajusteMensal = max(ZERO, whole(metaTipica).minus(whole(sobraTipica)));
  const margem = max(ZERO, sobraTipica.minus(metaTipica));
  const jaSobra = min(margem, spread.porMes).toDecimalPlaces(0, Prisma.Decimal.ROUND_DOWN);
  const porMes = ajusteMensal.plus(spread.porMes.minus(jaSobra)).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);

  if (!buraco && porMes.isZero()) return null;
  return {
    buraco,
    ajusteMensal,
    sobraTipica,
    metaTipica,
    compra: { porMes: spread.porMes, meses: spread.meses, jaSobra },
    porMes,
  };
}
