import { Prisma } from "@prisma/client";
import { prisma } from "../../core/db/prisma.js";
import { addMonthsClamped, daysInMonth, startOfUtcDay } from "../../core/http/date.js";
import { getAccountBalance } from "../accounts/accounts.service.js";
import { getBudgetSummary } from "../budget/budget.service.js";
import { getDailyBalance, getMonthlyTotals } from "../reports/reports.service.js";
import { getDebtOutstanding, isExpensiveDebt } from "../wealth/debt-outstanding.js";
import { getReserveTargetMonths } from "../settings/settings.service.js";
import { averageMonthlyCost } from "../wealth/wealth.service.js";

const ZERO = new Prisma.Decimal(0);

/** Savings target when the user hasn't set one (the app's 20–30% band floor). */
export const DEFAULT_TARGET_PERCENT = 20;
/** A debt at or above this monthly rate is paid off before saving. */
export { EXPENSIVE_DEBT_MONTHLY_RATE } from "../wealth/debt-outstanding.js";
/** Saldo kept untouched when suggesting how much to move: days of diário. */
export const SAFETY_DAYS_OF_DIARIO = 7;

const max = (a: Prisma.Decimal, b: Prisma.Decimal) => (a.greaterThan(b) ? a : b);
const min = (a: Prisma.Decimal, b: Prisma.Decimal) => (a.lessThan(b) ? a : b);
const pct = (part: Prisma.Decimal, whole: Prisma.Decimal) =>
  whole.isZero() ? ZERO : part.dividedBy(whole).times(100);

interface Overspending {
  categoryName: string;
  color: string;
  current: string;
  average: string;
  excess: string;
}

/**
 * Where diário + cartão went above its own recent habit: this month so far
 * vs. the average of the 3 previous months, pro-rated to the same share of
 * the month (so mid-month isn't compared against a full month).
 */
async function topOverspending(userId: string, year: number, month: number, elapsedFraction: number): Promise<Overspending[]> {
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));
  const historyStart = addMonthsClamped(monthStart, -3);
  const today = startOfUtcDay(new Date());
  const currentEnd = monthEnd.getTime() > today.getTime() ? new Date(today.getTime() + 86_400_000) : monthEnd;

  const [transactions, purchases] = await Promise.all([
    prisma.transaction.findMany({
      where: { userId, type: "diario", categoryId: { not: null }, date: { gte: historyStart, lt: currentEnd } },
      include: { category: true },
    }),
    // Card spending by invoice due date, consistent with the month's totals.
    prisma.installment.findMany({
      where: { dueDate: { gte: historyStart, lt: currentEnd }, purchase: { userId, categoryId: { not: null } } },
      select: { amount: true, dueDate: true, purchase: { select: { category: true } } },
    }),
  ]);

  const byCategory = new Map<string, { name: string; color: string; current: Prisma.Decimal; history: Prisma.Decimal }>();
  const add = (category: { id: string; name: string; color: string } | null, date: Date, amount: Prisma.Decimal.Value) => {
    if (!category) return;
    const entry = byCategory.get(category.id) ?? { name: category.name, color: category.color, current: ZERO, history: ZERO };
    if (date.getTime() >= monthStart.getTime()) entry.current = entry.current.plus(amount);
    else entry.history = entry.history.plus(amount);
    byCategory.set(category.id, entry);
  };
  for (const t of transactions) add(t.category, t.date, t.amount);
  for (const i of purchases) add(i.purchase.category, i.dueDate, i.amount);

  return [...byCategory.values()]
    .map((c) => {
      const expected = c.history.dividedBy(3).times(elapsedFraction);
      return { ...c, expected, excess: c.current.minus(expected) };
    })
    .filter((c) => c.excess.greaterThan(0) && c.history.greaterThan(0))
    .sort((a, b) => b.excess.comparedTo(a.excess))
    .slice(0, 3)
    .map((c) => ({
      categoryName: c.name,
      color: c.color,
      current: c.current.toFixed(2),
      average: c.expected.toFixed(2),
      excess: c.excess.toFixed(2),
    }));
}

/**
 * How many months of cost of living the `savings_reserve` accounts cover,
 * against the user's own target (`metaMeses`). `meses` is null while there's
 * no complete month of spending to measure. `falta` = custo × meta − reserva.
 */
export async function getReserveStatus(userId: string, today: Date) {
  const [reserveAccounts, metaMeses, avgCost] = await Promise.all([
    prisma.account.findMany({ where: { userId, isArchived: false, type: "savings_reserve" } }),
    getReserveTargetMonths(userId),
    averageMonthlyCost(userId, today),
  ]);
  let saldo = ZERO;
  for (const account of reserveAccounts) saldo = saldo.plus(await getAccountBalance(userId, account.id, today));
  if (!avgCost || avgCost.isZero()) return { saldo, custoMensal: null, meses: null, metaMeses, completa: false, falta: ZERO };
  const meses = saldo.dividedBy(avgCost);
  const completa = !meses.lessThan(metaMeses);
  return { saldo, custoMensal: avgCost, meses, metaMeses, completa, falta: completa ? ZERO : avgCost.times(metaMeses).minus(saldo) };
}

/**
 * Where the money saved this month should go first — the método's order:
 * the emergency reserve up to the user's target, then expensive debt, then
 * investing (or a caixinha for a bem, or buying it outright).
 */
export async function suggestDestination(userId: string, today: Date) {
  const reserve = await getReserveStatus(userId, today);
  // Without past spending there's no cost of living to size the reserve
  // against — never claim it's complete; building it is still the next step.
  if (reserve.meses == null) {
    return {
      kind: "reserva" as const,
      title: "Reserva de emergência",
      detail: `Ainda não há meses completos de gastos para medir a reserva. A meta é guardar ${reserve.metaMeses} meses do seu custo de vida antes de qualquer outra coisa.`,
    };
  }
  if (!reserve.completa) {
    return {
      kind: "reserva" as const,
      title: "Reserva de emergência",
      detail: `Ela cobre ${reserve.meses.toFixed(1).replace(".", ",")} meses; sua meta são ${reserve.metaMeses}. Faltam ${reserve.falta.toFixed(2)}.`,
    };
  }

  const debts = await prisma.debt.findMany({ where: { userId, status: { not: "paga" } } });
  const expensive = debts
    .map((debt) => ({ debt, outstanding: getDebtOutstanding(debt, today) }))
    .filter(({ debt, outstanding }) => !outstanding.value.isZero() && isExpensiveDebt(debt))
    .sort((a, b) => Number(b.debt.monthlyInterestRate ?? 99) - Number(a.debt.monthlyInterestRate ?? 99));
  if (expensive.length > 0) {
    const { debt, outstanding } = expensive[0];
    const rate = debt.monthlyInterestRate ? `${Number(debt.monthlyInterestRate).toString().replace(".", ",")}% ao mês` : "juros altos";
    return {
      kind: "divida" as const,
      title: `Quitar ${debt.creditor}`,
      creditor: debt.creditor,
      detail: `Reserva completa. Agora a dívida cara (${rate}): cada real pago nela rende mais que qualquer investimento. Falta ${outstanding.value.toFixed(2)}.`,
    };
  }

  return {
    kind: "investir" as const,
    title: "Investimentos e metas",
    detail:
      "Reserva completa e sem dívidas caras: o que sobrar pode ir para investimentos, para uma caixinha de entrada de um bem " +
      "ou para comprar à vista. Prefira o que valoriza — bens que desvalorizam, como carro, puxam o patrimônio para baixo.",
  };
}

/**
 * "Quanto dá para guardar este mês" — deterministic, explainable rules:
 *
 * 1. Sobra projetada = entradas − saídas − cartão − diário (real so far +
 *    previsão de diário for the remaining days) − economia already made.
 * 2. Teto de segurança = the lowest projected saldo from today to the end of
 *    the month, minus a week of diário: never suggest moving money that the
 *    account will need before the month ends.
 * 3. Pode guardar agora = max(0, min(sobra, teto)).
 * Compared honestly against the target (savings goal, else 20%).
 */
export async function getSavingsCapacity(userId: string, year: number, month: number) {
  const c = await computeMonthCapacity(userId, year, month);
  const today = startOfUtcDay(new Date());
  const fraction = c.numDays > 0 ? c.elapsedDays / c.numDays : 0;
  const [overspending, destino] = await Promise.all([
    c.elapsedDays > 0 && c.faltaParaMeta.greaterThan(0) ? topOverspending(userId, year, month, fraction) : Promise.resolve([]),
    suggestDestination(userId, today),
  ]);

  const money = (d: Prisma.Decimal) => d.toFixed(2);
  return {
    year,
    month,
    isPast: c.isPast,
    isFuture: c.isFuture,
    entradas: money(c.entradas),
    saidas: money(c.saidas),
    cartao: money(c.cartao),
    diarioReal: money(c.diarioReal),
    diarioPrevisto: money(c.diarioPrevisto),
    economiaFeita: money(c.economiaFeita),
    sobraProjetada: money(c.sobraProjetada),
    menorSaldoProjetado: c.minSaldo ? money(c.minSaldo) : null,
    folga: money(c.folga),
    podeGuardarAgora: money(c.podeGuardarAgora),
    limitadoPor: c.limitedBy,
    totalPossivel: money(c.totalPossivel),
    percentPossivel: pct(c.totalPossivel, c.entradas).toFixed(1),
    metaPercent: c.metaPercent.toFixed(0),
    metaValor: money(c.metaValor),
    faltaParaMeta: money(c.faltaParaMeta),
    overspending,
    destino,
  };
}

/**
 * The numbers behind getSavingsCapacity, without the extras (overspending,
 * destination) — cheap enough to run for every month of a simulation. Also
 * hands back the month's daily saldo it was computed from.
 */
export async function computeMonthCapacity(userId: string, year: number, month: number) {
  const today = startOfUtcDay(new Date());
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));
  const isPast = monthEnd.getTime() <= today.getTime();
  const isFuture = monthStart.getTime() > today.getTime();
  const numDays = daysInMonth(year, month);
  const elapsedDays = isPast ? numDays : isFuture ? 0 : today.getUTCDate();

  const [totals, days, budget, goal] = await Promise.all([
    getMonthlyTotals(userId, year, month),
    getDailyBalance(userId, year, month),
    getBudgetSummary(userId, year, month),
    prisma.savingsGoal.findFirst({
      where: { userId, OR: [{ periodType: "monthly", periodYear: year, periodMonth: month }, { periodType: "annual", periodYear: year }] },
      orderBy: { periodType: "desc" }, // monthly before annual
    }),
  ]);

  const entradas = new Prisma.Decimal(totals.entradas);
  const saidas = new Prisma.Decimal(totals.saidas);
  const cartao = new Prisma.Decimal(totals.cartao);
  const economiaFeita = new Prisma.Decimal(totals.economia);
  const diarioReal = new Prisma.Decimal(totals.diario);
  const diarioPrevisto = days.filter((d) => d.diarioIsForecast).reduce((s, d) => s.plus(d.diario), ZERO);
  const diario = diarioReal.plus(diarioPrevisto);

  const sobraProjetada = entradas.minus(saidas).minus(cartao).minus(diario).minus(economiaFeita);

  const dailyAverage = new Prisma.Decimal(budget.dailyAverage);
  const folga = dailyAverage.times(SAFETY_DAYS_OF_DIARIO);
  const remainingDays = days.filter((d) => !isPast && new Date(`${d.date}T00:00:00.000Z`).getTime() >= today.getTime());
  const minSaldo = remainingDays.length
    ? remainingDays.reduce((m, d) => min(m, new Prisma.Decimal(d.saldo)), new Prisma.Decimal(remainingDays[0].saldo))
    : null;
  const teto = minSaldo ? minSaldo.minus(folga) : null;

  const podeGuardarAgora = isPast ? ZERO : max(ZERO, teto ? min(sobraProjetada, teto) : sobraProjetada);
  const totalPossivel = economiaFeita.plus(podeGuardarAgora);

  const metaPercent = goal ? new Prisma.Decimal(goal.targetPercent) : new Prisma.Decimal(DEFAULT_TARGET_PERCENT);
  const metaValor = entradas.times(metaPercent).dividedBy(100);
  const faltaParaMeta = max(ZERO, metaValor.minus(totalPossivel));
  const limitedBy =
    isPast ? "mes_encerrado" : teto && teto.lessThan(sobraProjetada) ? "saldo" : "sobra";

  return {
    isPast,
    isFuture,
    numDays,
    elapsedDays,
    days,
    entradas,
    saidas,
    cartao,
    diarioReal,
    diarioPrevisto,
    economiaFeita,
    sobraProjetada,
    minSaldo,
    folga,
    podeGuardarAgora,
    limitedBy,
    totalPossivel,
    metaPercent,
    metaValor,
    faltaParaMeta,
  };
}
