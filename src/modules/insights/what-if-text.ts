import { Prisma } from "@prisma/client";
import type { Impact, MonthImpact, PurchasePlan, Verdict } from "./purchase-impact.js";

/**
 * Plain-language text for "E se?": fixed sentence templates filled with the
 * simulation's numbers — deterministic, never an estimate of its own. At most
 * three reasons (each carrying a number) and the paths that respect the
 * reserve guardian when the answer isn't "cabe".
 */

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const SHORT_MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

/** "R$ 1.235" — whole reais, Brazilian grouping; negatives as "R$ -420". */
export function brl(value: Prisma.Decimal) {
  const rounded = value.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
  const digits = rounded.abs().toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `R$ ${rounded.isNegative() ? "-" : ""}${digits}`;
}

/** "novembro", or "janeiro de 2027" outside the current year. */
export function monthName(mes: string, today: Date) {
  const [year, month] = mes.split("-").map(Number);
  const name = MONTHS[month - 1];
  return year === today.getUTCFullYear() ? name : `${name} de ${year}`;
}

/** "12/nov" */
export function shortDate(isoDate: string) {
  const [, month, day] = isoDate.split("-").map(Number);
  return `${day}/${SHORT_MONTHS[month - 1]}`;
}

const percentOf = (part: Prisma.Decimal, whole: Prisma.Decimal) =>
  whole.isZero() ? null : part.dividedBy(whole).times(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();

export interface TextOption {
  method: "pix" | "card";
  cardName?: string;
  installments: number;
  installmentAmount: Prisma.Decimal;
  total: Prisma.Decimal;
  /** Date the money first leaves the account. */
  firstDue: Date;
  impact: Impact;
  discount: Prisma.Decimal;
  floatGain: Prisma.Decimal;
}

export type Path =
  | { kind: "outra_forma"; option: TextOption }
  | { kind: "esperar"; mes: string; date: string; option: TextOption }
  | { kind: "juntar"; porMes: Prisma.Decimal; mes: string }
  | { kind: "sem_margem" };

export interface WhatIfTextInput {
  today: Date;
  description?: string;
  recurring: boolean;
  /** True when the app picked the payment method ("me ajuda a decidir"). */
  decided: boolean;
  chosen: TextOption;
  /** Every other option evaluated (decide mode), for the comparison line. */
  others: TextOption[];
  metaPercent: Prisma.Decimal;
  /** Why the reserve comes first: expensive debt or a reserve still being built. */
  priority: { kind: "divida"; creditor: string } | { kind: "reserva"; meses: Prisma.Decimal | null; metaMeses: number } | null;
  reserveSaldo: Prisma.Decimal;
  diarioPorDia: Prisma.Decimal;
  entradas: Prisma.Decimal;
  paths: Path[];
  /** What it takes for the purchase to fit (null when it already does). */
  plan: PurchasePlan | null;
  planHow: PlanHow | null;
}

/** "no Pix", "no Nubank em 1x", "no Nubank em 3x de R$ 500" */
export function paymentLabel(option: TextOption, recurring = false) {
  if (option.method === "pix") return "no Pix/débito";
  if (recurring || option.installments === 1) return `no ${option.cardName}${recurring ? "" : " em 1x"}`;
  return `no ${option.cardName} em ${option.installments}x de ${brl(option.installmentAmount)}`;
}

const daysBetween = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 86_400_000);

function worstBelowTarget(months: MonthImpact[]) {
  return months
    .filter((m) => m.furaMeta)
    .reduce<MonthImpact | null>((acc, m) => (!acc || m.guardaDepois.minus(m.metaValor).lessThan(acc.guardaDepois.minus(acc.metaValor)) ? m : acc), null);
}

function savingsLine(month: MonthImpact, metaPercent: Prisma.Decimal, today: Date) {
  const pctAfter = percentOf(month.guardaDepois, month.entradas);
  const less = month.guardaAntes.minus(month.guardaDepois);
  const when = `Em ${monthName(month.mes, today)}`;
  // The month already misses the target without the purchase.
  if (month.guardaAntes.lessThan(month.metaValor)) {
    const saved = pctAfter == null || pctAfter === 0 ? "não guardaria nada" : `guardaria só ${pctAfter}%`;
    return `${when} você ${saved} (meta: ${metaPercent.toFixed(0)}%, ${brl(month.metaValor)}) — mesmo sem a compra o mês não chega à meta.`;
  }
  if (pctAfter == null) return `${when} você guardaria ${brl(month.guardaDepois)} em vez de ${brl(month.guardaAntes)}.`;
  return `${when} você guardaria ${pctAfter}% em vez de ${metaPercent.toFixed(0)}% (${brl(less)} a menos).`;
}

function priorityLine(priority: WhatIfTextInput["priority"]) {
  if (!priority) return null;
  if (priority.kind === "divida") return `Você tem dívida cara com ${priority.creditor}: quitá-la vem antes.`;
  if (priority.meses == null) return "Você ainda não tem reserva de emergência medida: ela vem antes.";
  const meses = priority.meses.toDecimalPlaces(1).toString().replace(".", ",");
  return `Sua reserva cobre ${meses} de ${priority.metaMeses} meses: ela vem antes.`;
}

function headline(input: WhatIfTextInput) {
  const { chosen, decided, recurring } = input;
  const forma = paymentLabel(chosen, recurring);
  switch (chosen.impact.verdict) {
    case "cabe":
      if (recurring) return "Cabe no seu mês.";
      return decided ? `Pode comprar. Melhor ${forma}.` : `Pode comprar ${forma}.`;
    case "aperta":
      return decided ? `Dá, mas aperta. Prefira ${forma}.` : "Dá, mas aperta.";
    case "fura_reserva":
      return "Dá para pagar, mas fura sua reserva.";
    case "nao_cabe":
      return "Agora não cabe.";
  }
}

function verdictReasons(input: WhatIfTextInput): string[] {
  const { chosen, today, metaPercent } = input;
  const impact = chosen.impact;
  const lines: string[] = [];
  const verdict: Verdict = impact.verdict;

  if (verdict === "nao_cabe") {
    const negative = impact.months.filter((m) => m.ficaNegativoComACompra);
    const lowest = impact.lowestAfter!;
    // Negative on that day even without the purchase: it deepens a hole that already exists.
    if (lowest.antes.isNegative()) {
      const paid = lowest.antes.minus(lowest.value);
      lines.push(
        `Seu saldo já fica negativo em ${shortDate(lowest.date)} mesmo sem a compra (${brl(lowest.antes)}); a compra aumenta esse buraco em ${brl(paid)}.`
      );
      lines.push("Antes de comprar, resolva esse buraco — ou confira se falta lançar alguma entrada (ex.: salário).");
      return lines;
    }
    const names = negative.map((m) => monthName(m.mes, today));
    lines.push(`Seu saldo fica negativo em ${names.join(", ")} (até ${brl(lowest.value)} em ${shortDate(lowest.date)}).`);
    if (input.reserveSaldo.greaterThan(0)) lines.push("Só daria tirando dinheiro da reserva.");
    return lines;
  }

  const belowTarget = impact.pertinent ? worstBelowTarget(impact.months) : null;
  if (verdict === "fura_reserva" || (verdict === "aperta" && belowTarget)) {
    lines.push(savingsLine(belowTarget!, metaPercent, today));
    const priority = verdict === "fura_reserva" ? priorityLine(input.priority) : null;
    if (priority) lines.push(priority);
    return lines;
  }

  if (verdict === "aperta") {
    const low = impact.lowestAfter!;
    lines.push(`Seu saldo cai para ${brl(low.value)} em ${shortDate(low.date)}, menos de uma semana de diário.`);
    return lines;
  }

  // cabe
  if (chosen.method === "card" && !input.recurring) {
    const days = daysBetween(today, chosen.firstDue);
    lines.push(`A ${chosen.installments > 1 ? "primeira parcela" : "fatura"} vence em ${shortDate(chosen.firstDue.toISOString().slice(0, 10))}: o dinheiro fica com você por mais ${days} dias.`);
  }
  const firstPaying = impact.months.find((m) => m.pagaNoMes.greaterThan(0));
  if (firstPaying && firstPaying.entradas.greaterThan(0)) {
    const pct = percentOf(firstPaying.guardaDepois, firstPaying.entradas);
    lines.push(`Você ainda guarda ${pct}% em ${monthName(firstPaying.mes, today)} (meta: ${metaPercent.toFixed(0)}%).`);
  }
  if (impact.lowestAfter) lines.push(`Seu menor saldo fica em ${brl(impact.lowestAfter.value)} (${shortDate(impact.lowestAfter.date)}).`);
  return lines;
}

/** Why the chosen option beat the others: discount vs. card float, or the saldo the other one would leave. */
function comparisonLine(input: WhatIfTextInput) {
  if (!input.decided || input.recurring || input.chosen.impact.verdict === "nao_cabe") return null;
  const { chosen, others } = input;
  const pix = chosen.method === "pix" ? chosen : others.find((o) => o.method === "pix");
  const bestCard = [chosen, ...others].filter((o) => o.method === "card").sort((a, b) => b.floatGain.comparedTo(a.floatGain))[0];
  if (!pix || !bestCard) return null;

  if (chosen.method === "pix" && pix.discount.greaterThan(0)) {
    return `O desconto no Pix economiza ${brl(pix.discount)}; esperar a fatura renderia só ${brl(bestCard.floatGain)}.`;
  }
  if (chosen.method === "card") {
    if (pix.impact.verdict !== chosen.impact.verdict && pix.impact.lowestAfter && pix.impact.verdict !== "cabe") {
      return `No Pix seu saldo cairia para ${brl(pix.impact.lowestAfter.value)} em ${shortDate(pix.impact.lowestAfter.date)}.`;
    }
    if (pix.discount.greaterThan(0)) {
      return `Esperar a fatura rende ${brl(chosen.floatGain)}, mais que o desconto de ${brl(pix.discount)} no Pix.`;
    }
  }
  return null;
}

/** "Equivale a 15 dias do seu diário e a 40% da sua entrada do mês." */
function translationLine(input: WhatIfTextInput) {
  const value = input.recurring ? input.chosen.installmentAmount : input.chosen.total;
  const parts: string[] = [];
  if (input.diarioPorDia.greaterThan(0)) {
    const days = value.dividedBy(input.diarioPorDia).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
    if (days >= 1) parts.push(`${days} ${days === 1 ? "dia" : "dias"} do seu diário`);
  }
  const pct = percentOf(value, input.entradas);
  if (pct != null && pct >= 1) parts.push(`${pct}% da sua entrada do mês`);
  if (input.recurring) {
    const year = brl(value.times(12));
    return parts.length ? `São ${year} em 12 meses; por mês, equivale a ${parts.join(" e a ")}.` : `São ${year} em 12 meses.`;
  }
  return parts.length ? `Equivale a ${parts.join(" e a ")}.` : null;
}

function pathLine(path: Path, input: WhatIfTextInput) {
  const goal = input.chosen.impact.verdict === "fura_reserva" ? "sem furar a reserva" : "sem apertar";
  switch (path.kind) {
    case "outra_forma":
      return `${capitalize(paymentLabel(path.option))} cabe ${goal}.`;
    case "esperar":
      return `Ou espere até ${monthName(path.mes, input.today)}: a partir de ${shortDate(path.date)} cabe ${paymentLabel(path.option)}.`;
    case "juntar":
      return `Ou junte para ela: ${brl(path.porMes)}/mês além da sua meta, pronta em ${monthName(path.mes, input.today)}.`;
    case "sem_margem":
      return "Hoje não sobra nada acima da sua meta para juntar: o caminho é cortar gastos ou aumentar a entrada.";
  }
}

/** How the plan spreads the purchase over the months. */
export type PlanHow =
  | { kind: "parcelado"; cardName: string; installments: number }
  | { kind: "juntar_antes"; months: number }
  | { kind: "assinatura" };

/**
 * "O que você precisa": the hole that already exists this month, the monthly
 * spending cut to stop closing short and save the target, and the purchase
 * spread over the months — all numbers from purchasePlan.
 */
function planLines(input: WhatIfTextInput) {
  const { plan, planHow } = input;
  if (!plan || !planHow) return [];
  const meta = input.metaPercent.toFixed(0);
  const lines: string[] = [];
  if (plan.buraco) {
    lines.push(
      `Agora: ${brl(plan.buraco.valor)} para tirar o saldo do vermelho até ${shortDate(plan.buraco.data)} — esse buraco já existe sem a compra.`
    );
  }
  if (plan.ajusteMensal.greaterThan(0)) {
    lines.push(
      plan.sobraTipica.isNegative()
        ? `Todo mês: gastar ${brl(plan.ajusteMensal)} a menos. Hoje sai ${brl(plan.sobraTipica.negated())} a mais do que entra, e guardar ${meta}% pede ${brl(plan.metaTipica)}.`
        : `Todo mês: gastar ${brl(plan.ajusteMensal)} a menos para guardar ${meta}% (${brl(plan.metaTipica)}); hoje sobram ${brl(plan.sobraTipica)}.`
    );
  }
  const compra = plan.compra;
  const compraFalta = compra.porMes.minus(compra.jaSobra);
  if (compra.porMes.greaterThan(0)) {
    const covered = compra.jaSobra.greaterThan(0)
      ? compraFalta.greaterThan(0)
        ? ` ${brl(compra.jaSobra)} disso já sobram acima da meta.`
        : " Isso já sobra acima da sua meta."
      : "";
    const how =
      planHow.kind === "parcelado"
        ? `Para a compra: mais ${brl(compra.porMes)}/mês por ${compra.meses} meses, parcelando no ${planHow.cardName} em ${planHow.installments}x.`
        : planHow.kind === "juntar_antes"
          ? `Para a compra: juntar ${brl(compra.porMes)}/mês por ${compra.meses} meses antes e pagar no Pix.`
          : `Para a assinatura: mais ${brl(compra.porMes)}/mês.`;
    lines.push(how + covered);
  }
  if (plan.ajusteMensal.greaterThan(0) && compraFalta.greaterThan(0)) {
    const during = planHow.kind === "assinatura" ? "" : ` durante ${compra.meses} meses`;
    lines.push(`Ao todo: ${brl(plan.porMes)}/mês a menos de gastos (ou a mais de entrada)${during}.`);
  }
  return lines;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function buildWhatIfText(input: WhatIfTextInput) {
  // At most three reasons; the comparison (decide mode) outranks the last one.
  const comparison = comparisonLine(input);
  const kept = verdictReasons(input).slice(0, comparison ? 2 : 3);
  if (comparison) kept.push(comparison);
  const translation = translationLine(input);
  if (translation) kept.push(translation);
  return {
    manchete: headline(input),
    motivos: kept,
    caminhos: input.paths.filter((p) => !(p.kind === "sem_margem" && input.plan)).map((p) => pathLine(p, input)),
    planoLinhas: planLines(input),
  };
}
