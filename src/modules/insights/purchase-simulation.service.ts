import { Prisma } from "@prisma/client";
import { prisma } from "../../core/db/prisma.js";
import { addMonthsClamped, startOfUtcDay } from "../../core/http/date.js";
import { AppError } from "../../core/http/errors.js";
import { generateInstallmentPlan } from "../../services/installment-generator.service.js";
import { loadBaseline } from "./purchase-baseline.js";
import type { CashOut } from "./purchase-impact.js";
import { evaluateCashOuts, isPertinent, monthIndexOf } from "./purchase-impact.js";

export { MAX_SIMULATED_MONTHS } from "./purchase-baseline.js";

const ZERO = new Prisma.Decimal(0);

export interface PurchaseSimulationInput {
  amount: string;
  /** Card purchases only; débito/Pix is always a single payment. */
  installments?: number;
  /** Omitted = paid from the account (débito/Pix) on `date`. */
  cardId?: string;
  date: Date;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const money = (d: Prisma.Decimal) => d.toFixed(2);

/**
 * When the money leaves the account: a card purchase on each installment's
 * invoice due date (same `generateInstallmentPlan` as a real one), débito/Pix
 * on the day. `monthly` repeats it every month for 12 months (an assinatura).
 */
export function planCashOuts(params: {
  amount: Prisma.Decimal;
  date: Date;
  card?: { closingDay: number; dueDay: number } | null;
  installments?: number;
  monthly?: boolean;
}): CashOut[] {
  const { amount, date, card } = params;
  if (params.monthly) {
    return Array.from({ length: 12 }, (_, i) => planCashOuts({ amount, date: addMonthsClamped(date, i), card })).flat();
  }
  if (!card) return [{ date, amount }];
  return generateInstallmentPlan({ card, purchaseDate: date, totalAmount: amount, installmentsCount: params.installments ?? 1 }).map(
    (p) => ({ date: p.dueDate, amount: p.amount })
  );
}

export async function getOwnedCard(userId: string, cardId: string) {
  const card = await prisma.card.findUnique({ where: { id: cardId } });
  if (!card || card.userId !== userId) throw AppError.notFound("Card not found");
  return card;
}

/**
 * "Posso comprar?" — overlays a hypothetical purchase on the real Saldos
 * projection (which already includes previsão de diário, recurring bills and
 * existing installments) without saving anything. See purchase-impact.ts for
 * the verdict rules, including the reserve guardian.
 */
export async function simulatePurchase(userId: string, input: PurchaseSimulationInput) {
  const today = startOfUtcDay(new Date());
  const amount = new Prisma.Decimal(input.amount);
  if (amount.lessThanOrEqualTo(0)) throw AppError.badRequest("amount must be positive");
  if (input.date.getTime() < today.getTime()) throw AppError.badRequest("date can't be in the past");

  const card = input.cardId ? await getOwnedCard(userId, input.cardId) : null;
  const installments = card ? (input.installments ?? 1) : 1;
  const cashOuts = planCashOuts({ amount, date: input.date, card, installments });

  const lastIndex = Math.max(...cashOuts.map((c) => monthIndexOf(c.date)));
  const { baseline } = await loadBaseline(userId, monthIndexOf(input.date), lastIndex);
  const impact = evaluateCashOuts(baseline, cashOuts, { fromDate: input.date, pertinent: isPertinent(baseline, amount) });
  const months = impact.months;

  const negative = months.filter((mo) => mo.ficaNegativoComACompra);
  const newlyNegative = negative.filter((mo) => !mo.jaNegativoSemACompra);
  const belowTarget = months.filter((mo) => mo.furaMeta);
  const reason =
    newlyNegative.length > 0
      ? `A compra deixa o saldo negativo em ${newlyNegative.map((mo) => mo.mes).join(", ")}.`
      : negative.length > 0
        ? `O saldo já fica negativo sem a compra em ${negative.map((mo) => mo.mes).join(", ")}; ela aprofunda o buraco.`
        : impact.verdict === "fura_reserva"
          ? `O saldo aguenta, mas você guardaria menos que a meta de ${baseline.metaPercent.toFixed(0)}% em ${belowTarget.map((mo) => mo.mes).join(", ")} — e a reserva ainda não está completa.`
          : impact.verdict === "aperta" && belowTarget.length > 0 && impact.pertinent
            ? `O saldo aguenta, mas você guardaria menos que a meta de ${baseline.metaPercent.toFixed(0)}% em ${belowTarget.map((mo) => mo.mes).join(", ")}.`
            : impact.verdict === "aperta"
              ? "O saldo fica positivo, mas abaixo da folga de uma semana de diário em algum momento."
              : "O saldo continua com folga em todos os meses em que você paga a compra.";

  // "Dá para guardar" of the first month that pays something: card spending
  // counts in the month each installment is due (débito/Pix, on the day).
  const firstDueMes = iso(cashOuts[0].date).slice(0, 7);
  const firstDueMonth = months.find((mo) => mo.mes === firstDueMes) ?? months[0];
  const firstBase = baseline.months.find((m) => m.mes === firstDueMonth.mes);

  return {
    compra: {
      valor: money(amount),
      formaDePagamento: card ? card.name : "débito/Pix",
      parcelas: installments,
      valorParcela: money(cashOuts[0].amount),
      dataDaCompra: iso(input.date),
      vencimentos: cashOuts.map((c) => ({ data: iso(c.date), valor: money(c.amount) })),
    },
    veredito: impact.verdict,
    motivo: reason,
    folgaUsada: money(firstDueMonth.folga),
    meses: months.map((mo) => ({
      mes: mo.mes,
      pagaNoMes: money(mo.pagaNoMes),
      menorSaldoAntes: mo.menorSaldoAntes ? { data: mo.menorSaldoAntes.date, valor: money(mo.menorSaldoAntes.value) } : null,
      menorSaldoDepois: mo.menorSaldoDepois ? { data: mo.menorSaldoDepois.date, valor: money(mo.menorSaldoDepois.value) } : null,
      saldoFimDoMesAntes: money(mo.saldoFimDoMesAntes),
      saldoFimDoMesDepois: money(mo.saldoFimDoMesDepois),
      guardaAntes: money(mo.guardaAntes),
      guardaDepois: money(mo.guardaDepois),
      meta: money(mo.metaValor),
      jaNegativoSemACompra: mo.jaNegativoSemACompra,
      ficaNegativoComACompra: mo.ficaNegativoComACompra,
      ficaAbaixoDaMeta: mo.furaMeta,
    })),
    daParaGuardarNoPrimeiroVencimento: {
      mes: firstDueMonth.mes,
      antes: firstBase?.isPast ? "0.00" : money(firstDueMonth.guardaAntes.minus(firstDueMonth.economiaFeita)),
      depois: firstBase?.isPast ? "0.00" : money(Prisma.Decimal.max(ZERO, firstDueMonth.guardaDepois.minus(firstDueMonth.economiaFeita))),
      meta: money(firstDueMonth.metaValor),
      nota: "No cartão, cada parcela conta no mês do vencimento da fatura; no débito/Pix, no dia da compra.",
    },
    metaPercent: baseline.metaPercent.toFixed(0),
    reservaPrimeiro: baseline.strict,
    simulado: true,
  };
}
