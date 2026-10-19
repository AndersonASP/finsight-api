import { Prisma } from "@prisma/client";
import { prisma } from "../../core/db/prisma.js";
import { startOfUtcDay } from "../../core/http/date.js";
import { AppError } from "../../core/http/errors.js";
import { loadBaseline, type LoadedBaseline } from "./purchase-baseline.js";
import type { Baseline, CashOut, Impact } from "./purchase-impact.js";
import type { PurchasePlan } from "./purchase-impact.js";
import { evaluateCashOuts, isPertinent, monthIndexOf, purchasePlan, referenceEntradas, saveUpPlan, VERDICT_SEVERITY } from "./purchase-impact.js";
import { getOwnedCard, planCashOuts } from "./purchase-simulation.service.js";
import { buildWhatIfText, type Path, type PlanHow, type TextOption } from "./what-if-text.js";

const ZERO = new Prisma.Decimal(0);

/**
 * What the money earns while it waits for the invoice due date (≈ 100% of
 * the CDI, ~10% a.a.). Only used to weigh a Pix discount against paying
 * later; an estimate, so it never decides between two different verdicts.
 */
export const FLOAT_MONTHLY_RATE = 0.008;
/** "Espere até…" looks this many months ahead. */
export const WAIT_MONTHS = 6;
/** With no card to split it, the plan saves up for a Pix purchase over this many months. */
export const PLAN_SAVE_MONTHS = 6;

export type PaymentChoice = { method: "pix" } | { method: "card"; cardId: string; installments: number } | { method: "decide" };

export interface WhatIfInput {
  description?: string;
  amount: string;
  payment: PaymentChoice;
  /** Discount for paying à vista (Pix/débito), in %. */
  pixDiscountPercent?: number;
  /** The store splits up to this many times without interest (decide mode tries 1..N on each card). */
  interestFreeInstallments?: number;
  /** A monthly charge (assinatura) instead of a one-off purchase: simulated for 12 months. */
  recurring?: boolean;
}

interface OptionSpec {
  method: "pix" | "card";
  card?: { id: string; name: string; closingDay: number; dueDay: number };
  installments: number;
}

interface EvaluatedOption extends TextOption {
  spec: OptionSpec;
  date: Date;
  cashOuts: CashOut[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const money = (d: Prisma.Decimal) => d.toFixed(2);

/**
 * Same severity → the larger advantage (discount or float), then the higher
 * lowest saldo. When nothing fits, the one that digs the shallowest hole.
 */
function compareOptions(a: EvaluatedOption, b: EvaluatedOption) {
  const severity = VERDICT_SEVERITY[a.impact.verdict] - VERDICT_SEVERITY[b.impact.verdict];
  if (severity !== 0) return severity;
  const low = (o: EvaluatedOption) => o.impact.lowestAfter?.value ?? new Prisma.Decimal(Number.MAX_SAFE_INTEGER);
  if (a.impact.verdict === "nao_cabe") return low(b).comparedTo(low(a));
  const advantage = (o: EvaluatedOption) => (o.method === "pix" ? o.discount : o.floatGain);
  const byAdvantage = advantage(b).comparedTo(advantage(a));
  if (byAdvantage !== 0) return byAdvantage;
  return low(b).comparedTo(low(a));
}

/** Per card, the fewest installments that reach the best verdict that card can get. */
function bestPerCard(options: EvaluatedOption[]) {
  const byCard = new Map<string, EvaluatedOption>();
  for (const o of options) {
    if (o.method !== "card") continue;
    const current = byCard.get(o.spec.card!.id);
    const better =
      !current ||
      VERDICT_SEVERITY[o.impact.verdict] < VERDICT_SEVERITY[current.impact.verdict] ||
      (o.impact.verdict === current.impact.verdict && o.installments < current.installments);
    if (better) byCard.set(o.spec.card!.id, o);
  }
  return [...byCard.values()];
}

function optionJson(o: EvaluatedOption) {
  return {
    forma: o.method === "pix" ? "pix" : "cartao",
    cardId: o.spec.card?.id ?? null,
    nome: o.method === "pix" ? "Pix/débito" : o.spec.card!.name,
    parcelas: o.installments,
    valorTotal: money(o.total),
    valorParcela: money(o.installmentAmount),
    dataDaCompra: iso(o.date),
    vencimentos: o.cashOuts.map((c) => ({ data: iso(c.date), valor: money(c.amount) })),
    veredito: o.impact.verdict,
    menorSaldo: o.impact.lowestAfter
      ? { data: o.impact.lowestAfter.date, valor: money(o.impact.lowestAfter.value), semACompra: money(o.impact.lowestAfter.antes) }
      : null,
    desconto: money(o.discount),
    ganhoDePrazo: money(o.floatGain),
    meses: o.impact.months.map((m) => ({
      mes: m.mes,
      pagaNoMes: money(m.pagaNoMes),
      menorSaldoAntes: m.menorSaldoAntes ? { data: m.menorSaldoAntes.date, valor: money(m.menorSaldoAntes.value) } : null,
      menorSaldoDepois: m.menorSaldoDepois ? { data: m.menorSaldoDepois.date, valor: money(m.menorSaldoDepois.value) } : null,
      guardaAntes: money(m.guardaAntes),
      guardaDepois: money(m.guardaDepois),
      meta: money(m.metaValor),
      ficaAbaixoDaMeta: m.furaMeta,
      ficaNegativo: m.ficaNegativoComACompra,
    })),
  };
}

/**
 * Evaluates purchases against one loaded baseline. Kept apart from the
 * request handling so the "Quero comprar" list can judge every item on the
 * same projection.
 */
export class WhatIfEvaluator {
  constructor(
    readonly loaded: LoadedBaseline,
    private readonly cards: OptionSpec["card"][]
  ) {}

  get baseline(): Baseline {
    return this.loaded.baseline;
  }

  evaluate(
    spec: OptionSpec,
    params: { amount: Prisma.Decimal; pixAmount: Prisma.Decimal; recurring: boolean; pertinent: boolean; untilIndex?: number; date?: Date }
  ) {
    const date = params.date ?? this.baseline.today;
    const total = spec.method === "pix" ? params.pixAmount : params.amount;
    const cashOuts = planCashOuts({
      amount: total,
      date,
      card: spec.card ?? null,
      installments: spec.installments,
      monthly: params.recurring,
    });
    const impact: Impact = evaluateCashOuts(this.baseline, cashOuts, {
      fromDate: date,
      pertinent: params.pertinent,
      untilIndex: params.untilIndex,
    });
    const floatGain = cashOuts.reduce((sum, c) => {
      const days = Math.max(0, (c.date.getTime() - this.baseline.today.getTime()) / 86_400_000);
      return sum.plus(c.amount.times(FLOAT_MONTHLY_RATE).times(days).dividedBy(30));
    }, ZERO);
    const option: EvaluatedOption = {
      spec,
      date,
      cashOuts,
      method: spec.method,
      cardName: spec.card?.name,
      installments: spec.installments,
      installmentAmount: cashOuts[0].amount,
      total,
      firstDue: cashOuts[0].date,
      impact,
      discount: spec.method === "pix" ? params.amount.minus(params.pixAmount) : ZERO,
      floatGain: spec.method === "pix" ? ZERO : floatGain.toDecimalPlaces(2),
    };
    return option;
  }

  /** Pix plus every card at 1..maxInstallments (1 for an assinatura). */
  candidateSpecs(maxInstallments: number, recurring: boolean): OptionSpec[] {
    const specs: OptionSpec[] = [{ method: "pix", installments: 1 }];
    for (const card of this.cards) {
      for (let k = 1; k <= (recurring ? 1 : maxInstallments); k++) specs.push({ method: "card", card, installments: k });
    }
    return specs;
  }

  /** "Espere até…": the same payment on the best day (highest projected saldo) of each coming month. */
  firstMonthItFits(spec: OptionSpec, params: Parameters<WhatIfEvaluator["evaluate"]>[1]) {
    const currentIndex = monthIndexOf(this.baseline.today);
    for (let w = 1; w <= WAIT_MONTHS; w++) {
      const month = this.baseline.months.find((m) => m.index === currentIndex + w);
      if (!month || month.days.length === 0) break;
      const bestDay = month.days.reduce((a, b) => (b.saldo.greaterThan(a.saldo) ? b : a));
      const option = this.evaluate(spec, { ...params, date: new Date(bestDay.time) });
      if (option.impact.verdict === "cabe") return { mes: month.mes, date: bestDay.date, option };
    }
    return null;
  }
}

export async function loadEvaluator(userId: string, horizonMonths: number) {
  const today = startOfUtcDay(new Date());
  const currentIndex = monthIndexOf(today);
  const [loaded, cards] = await Promise.all([
    loadBaseline(userId, currentIndex, currentIndex + horizonMonths - 1),
    prisma.card.findMany({ where: { userId, isArchived: false }, orderBy: { createdAt: "asc" } }),
  ]);
  return new WhatIfEvaluator(
    loaded,
    cards.map((c) => ({ id: c.id, name: c.name, closingDay: c.closingDay, dueDay: c.dueDay }))
  );
}

/** Months of projection a what-if needs: the payments, "espere até…" and 12 months of "junte para ela". */
export const horizonFor = (maxInstallments: number) => Math.max(12, WAIT_MONTHS + maxInstallments + 1);

/**
 * "E se?" — simulates a purchase (or a monthly charge) made today against
 * the real projection, picks the payment method when asked, applies the
 * reserve guardian and explains it in plain text. Nothing is saved.
 */
export async function whatIf(userId: string, input: WhatIfInput, evaluator?: WhatIfEvaluator) {
  const amount = new Prisma.Decimal(input.amount);
  if (amount.lessThanOrEqualTo(0)) throw AppError.badRequest("amount must be positive");
  const recurring = input.recurring ?? false;
  const discountPercent = new Prisma.Decimal(input.pixDiscountPercent ?? 0);
  const pixAmount = amount.times(new Prisma.Decimal(100).minus(discountPercent)).dividedBy(100).toDecimalPlaces(2);

  let chosenCard: OptionSpec["card"] | undefined;
  if (input.payment.method === "card") {
    const card = await getOwnedCard(userId, input.payment.cardId);
    chosenCard = { id: card.id, name: card.name, closingDay: card.closingDay, dueDay: card.dueDay };
  }
  const chosenInstallments = input.payment.method === "card" && !recurring ? input.payment.installments : 1;
  const maxInstallments = recurring ? 1 : Math.max(input.interestFreeInstallments ?? 1, chosenInstallments);

  const ev = evaluator ?? (await loadEvaluator(userId, horizonFor(maxInstallments)));
  const baseline = ev.baseline;
  const specs = ev.candidateSpecs(maxInstallments, recurring);
  if (chosenCard) specs.push({ method: "card", card: chosenCard, installments: chosenInstallments });
  // Every option is judged over the same months: up to the last payment of any of them.
  const untilIndex = Math.max(
    ...specs.flatMap((spec) =>
      planCashOuts({ amount, date: baseline.today, card: spec.card ?? null, installments: spec.installments, monthly: recurring }).map((c) =>
        monthIndexOf(c.date)
      )
    )
  );
  const params = { amount, pixAmount, recurring, pertinent: recurring || isPertinent(baseline, amount), untilIndex };

  const candidates = specs.map((spec) => ev.evaluate(spec, params));
  const decided = input.payment.method === "decide";
  const shortlist = [candidates[0], ...bestPerCard(candidates)].sort(compareOptions);

  let chosen: EvaluatedOption;
  if (input.payment.method === "decide") chosen = shortlist[0];
  else if (input.payment.method === "pix") chosen = candidates[0];
  else chosen = candidates[candidates.length - 1];

  // Paths that respect the guardian when the answer isn't "cabe".
  const paths: Path[] = [];
  let alternative: EvaluatedOption | null = null;
  if (chosen.impact.verdict !== "cabe" && !recurring) {
    const otherThatFits = decided ? null : shortlist.find((o) => o.impact.verdict === "cabe");
    if (otherThatFits) {
      alternative = otherThatFits;
      paths.push({ kind: "outra_forma", option: otherThatFits });
    }
    const wait = ev.firstMonthItFits(chosen.spec, { ...params, untilIndex: undefined });
    if (wait) {
      alternative ??= wait.option as EvaluatedOption;
      paths.push({ kind: "esperar", mes: wait.mes, date: wait.date, option: wait.option });
    }
    const saveUp = saveUpPlan(baseline, chosen.total);
    paths.push(saveUp ? { kind: "juntar", porMes: saveUp.porMes, mes: saveUp.mes } : { kind: "sem_margem" });
  }

  // What it would take to buy without going negative and while saving the target.
  let plan: PurchasePlan | null = null;
  let planHow: PlanHow | null = null;
  if (chosen.impact.verdict !== "cabe") {
    const spreadCard =
      chosen.method === "card" && chosen.installments > 1
        ? chosen
        : candidates.filter((o) => o.method === "card").sort((a, b) => b.installments - a.installments)[0];
    if (recurring) {
      planHow = { kind: "assinatura" };
      plan = purchasePlan(baseline, { porMes: chosen.installmentAmount, meses: 12 });
    } else if (spreadCard && spreadCard.installments > 1) {
      planHow = { kind: "parcelado", cardName: spreadCard.cardName!, installments: spreadCard.installments };
      plan = purchasePlan(baseline, { porMes: spreadCard.installmentAmount, meses: spreadCard.installments });
    } else {
      planHow = { kind: "juntar_antes", months: PLAN_SAVE_MONTHS };
      plan = purchasePlan(baseline, {
        porMes: pixAmount.dividedBy(PLAN_SAVE_MONTHS).toDecimalPlaces(0, Prisma.Decimal.ROUND_UP),
        meses: PLAN_SAVE_MONTHS,
      });
    }
  }

  const { destino, reserve, diarioPorDia } = ev.loaded;
  const priority = !baseline.strict
    ? null
    : destino.kind === "divida"
      ? { kind: "divida" as const, creditor: destino.creditor }
      : { kind: "reserva" as const, meses: reserve.meses, metaMeses: reserve.metaMeses };
  const entradas = referenceEntradas(baseline);

  const text = buildWhatIfText({
    today: baseline.today,
    description: input.description,
    recurring,
    decided,
    chosen,
    others: decided ? shortlist.filter((o) => o !== chosen) : [],
    metaPercent: baseline.metaPercent,
    priority,
    reserveSaldo: reserve.saldo,
    diarioPorDia,
    entradas,
    paths,
    plan,
    planHow,
  });

  const { planoLinhas, ...textRest } = text;
  const value = recurring ? chosen.installmentAmount : chosen.total;
  return {
    descricao: input.description ?? null,
    valor: money(amount),
    recorrente: recurring,
    decidido: decided,
    veredito: chosen.impact.verdict,
    ...textRest,
    escolhida: optionJson(chosen),
    opcoes: decided ? shortlist.map(optionJson) : [optionJson(chosen)],
    alternativa: alternative ? optionJson(alternative) : null,
    plano: plan
      ? {
          linhas: planoLinhas,
          buraco: plan.buraco ? { valor: money(plan.buraco.valor), data: plan.buraco.data } : null,
          ajusteMensal: money(plan.ajusteMensal),
          compraPorMes: money(plan.compra.porMes.minus(plan.compra.jaSobra)),
          meses: plan.compra.meses,
          porMes: money(plan.porMes),
        }
      : null,
    reserva: {
      saldo: money(reserve.saldo),
      meses: reserve.meses ? reserve.meses.toFixed(1) : null,
      metaMeses: reserve.metaMeses,
      completa: reserve.completa,
      vemPrimeiro: baseline.strict,
    },
    metaPercent: baseline.metaPercent.toFixed(0),
    traducao: {
      diasDeDiario: diarioPorDia.greaterThan(0) ? value.dividedBy(diarioPorDia).toFixed(0) : null,
      percentDaEntrada: entradas.greaterThan(0) ? value.dividedBy(entradas).times(100).toFixed(0) : null,
    },
    simulado: true,
  };
}
