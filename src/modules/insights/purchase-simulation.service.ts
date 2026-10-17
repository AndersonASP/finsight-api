import { Prisma } from "@prisma/client";
import { prisma } from "../../core/db/prisma.js";
import { startOfUtcDay } from "../../core/http/date.js";
import { AppError } from "../../core/http/errors.js";
import { generateInstallmentPlan } from "../../services/installment-generator.service.js";
import { getDailyBalance } from "../reports/reports.service.js";
import { getSavingsCapacity } from "./savings-capacity.service.js";

const ZERO = new Prisma.Decimal(0);
/** Never project further than this, whatever the installment count. */
export const MAX_SIMULATED_MONTHS = 24;

export interface PurchaseSimulationInput {
  amount: string;
  /** Card purchases only; débito/Pix is always a single payment. */
  installments?: number;
  /** Omitted = paid from the account (débito/Pix) on `date`. */
  cardId?: string;
  date: Date;
}

interface CashOut {
  date: Date;
  amount: Prisma.Decimal;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const money = (d: Prisma.Decimal) => d.toFixed(2);
const monthIndex = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();

/**
 * "Posso comprar?" — overlays a hypothetical purchase on the real Saldos
 * projection (which already includes previsão de diário, recurring bills and
 * existing installments) without saving anything. A card purchase leaves the
 * account on each installment's invoice due date, exactly as a real one
 * would (same `generateInstallmentPlan`); débito/Pix leaves on the day.
 */
export async function simulatePurchase(userId: string, input: PurchaseSimulationInput) {
  const today = startOfUtcDay(new Date());
  const amount = new Prisma.Decimal(input.amount);
  if (amount.lessThanOrEqualTo(0)) throw AppError.badRequest("amount must be positive");
  if (input.date.getTime() < today.getTime()) throw AppError.badRequest("date can't be in the past");

  let cashOuts: CashOut[];
  let paymentName: string;
  const installments = input.cardId ? (input.installments ?? 1) : 1;
  if (input.cardId) {
    const card = await prisma.card.findUnique({ where: { id: input.cardId } });
    if (!card || card.userId !== userId) throw AppError.notFound("Card not found");
    paymentName = card.name;
    cashOuts = generateInstallmentPlan({ card, purchaseDate: input.date, totalAmount: amount, installmentsCount: installments }).map(
      (p) => ({ date: p.dueDate, amount: p.amount })
    );
  } else {
    paymentName = "débito/Pix";
    cashOuts = [{ date: input.date, amount }];
  }

  const firstMonth = monthIndex(input.date);
  const lastMonth = Math.min(Math.max(...cashOuts.map((c) => monthIndex(c.date))), firstMonth + MAX_SIMULATED_MONTHS - 1);

  const months = [];
  for (let m = firstMonth; m <= lastMonth; m++) {
    const year = Math.floor(m / 12);
    const month = (m % 12) + 1;
    const monthStart = new Date(Date.UTC(year, month - 1, 1));
    const days = await getDailyBalance(userId, year, month);

    let lowestBefore: { date: string; value: Prisma.Decimal } | null = null;
    let lowestAfter: { date: string; value: Prisma.Decimal } | null = null;
    let endBefore = ZERO;
    let endAfter = ZERO;
    for (const day of days) {
      const dayDate = new Date(`${day.date}T00:00:00.000Z`);
      const paidSoFar = cashOuts
        .filter((c) => c.date.getTime() <= dayDate.getTime())
        .reduce((sum, c) => sum.plus(c.amount), ZERO);
      const before = new Prisma.Decimal(day.saldo);
      const after = before.minus(paidSoFar);
      endBefore = before;
      endAfter = after;
      if (dayDate.getTime() < today.getTime()) continue; // the past can't change
      if (!lowestBefore || before.lessThan(lowestBefore.value)) lowestBefore = { date: day.date, value: before };
      if (!lowestAfter || after.lessThan(lowestAfter.value)) lowestAfter = { date: day.date, value: after };
    }

    const dueThisMonth = cashOuts
      .filter((c) => monthIndex(c.date) === m)
      .reduce((sum, c) => sum.plus(c.amount), ZERO);
    months.push({
      mes: `${year}-${String(month).padStart(2, "0")}`,
      pagaNoMes: money(dueThisMonth),
      menorSaldoAntes: lowestBefore ? { data: lowestBefore.date, valor: money(lowestBefore.value) } : null,
      menorSaldoDepois: lowestAfter ? { data: lowestAfter.date, valor: money(lowestAfter.value) } : null,
      saldoFimDoMesAntes: money(endBefore),
      saldoFimDoMesDepois: money(endAfter),
      jaNegativoSemACompra: lowestBefore ? lowestBefore.value.isNegative() : false,
      ficaNegativoComACompra: lowestAfter ? lowestAfter.value.isNegative() : false,
      _monthStart: monthStart,
      _lowestAfter: lowestAfter?.value ?? null,
    });
  }

  // "Dá para guardar" of the first month that pays something: card spending
  // counts in the month each installment is due (débito/Pix, on the day), and
  // the safety ceiling uses that month's saldo with the purchase.
  const firstDue = cashOuts[0];
  const firstDueMonth = months.find((mo) => mo.mes === iso(firstDue.date).slice(0, 7)) ?? months[0];
  const dueInFirstMonth = new Prisma.Decimal(firstDueMonth.pagaNoMes);
  const capacity = await getSavingsCapacity(userId, firstDue.date.getUTCFullYear(), firstDue.date.getUTCMonth() + 1);
  const folga = new Prisma.Decimal(capacity.folga);
  const sobraDepois = new Prisma.Decimal(capacity.sobraProjetada).minus(dueInFirstMonth);
  const tetoDepois = firstDueMonth._lowestAfter ? firstDueMonth._lowestAfter.minus(folga) : null;
  const ceiling = tetoDepois ? (tetoDepois.lessThan(sobraDepois) ? tetoDepois : sobraDepois) : sobraDepois;
  const podeGuardarDepois = ceiling.greaterThan(0) ? ceiling : ZERO;

  const tight = months.some((mo) => mo._lowestAfter != null && mo._lowestAfter.lessThan(folga));
  const negative = months.filter((mo) => mo.ficaNegativoComACompra);
  const newlyNegative = negative.filter((mo) => !mo.jaNegativoSemACompra);
  const verdict = negative.length > 0 ? "nao_cabe" : tight ? "aperta" : "cabe";
  const reason =
    newlyNegative.length > 0
      ? `A compra deixa o saldo negativo em ${newlyNegative.map((mo) => mo.mes).join(", ")}.`
      : negative.length > 0
        ? `O saldo já fica negativo sem a compra em ${negative.map((mo) => mo.mes).join(", ")}; ela aprofunda o buraco.`
        : tight
          ? "O saldo fica positivo, mas abaixo da folga de uma semana de diário em algum momento."
          : "O saldo continua com folga em todos os meses em que você paga a compra.";

  return {
    compra: {
      valor: money(amount),
      formaDePagamento: paymentName,
      parcelas: installments,
      valorParcela: money(cashOuts[0].amount),
      dataDaCompra: iso(input.date),
      vencimentos: cashOuts.map((c) => ({ data: iso(c.date), valor: money(c.amount) })),
    },
    veredito: verdict,
    motivo: reason,
    folgaUsada: money(folga),
    meses: months.map(({ _monthStart, _lowestAfter, ...rest }) => rest),
    daParaGuardarNoPrimeiroVencimento: {
      mes: firstDueMonth.mes,
      antes: capacity.podeGuardarAgora,
      depois: capacity.isPast ? "0.00" : money(podeGuardarDepois),
      meta: capacity.metaValor,
      nota: "No cartão, cada parcela conta no mês do vencimento da fatura; no débito/Pix, no dia da compra.",
    },
    simulado: true,
  };
}
