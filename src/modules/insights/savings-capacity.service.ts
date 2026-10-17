import { Prisma } from "@prisma/client";
import { prisma } from "../../core/db/prisma.js";
import { addMonthsClamped, daysInMonth, startOfUtcDay } from "../../core/http/date.js";
import { getAccountBalance } from "../accounts/accounts.service.js";
import { getBudgetSummary } from "../budget/budget.service.js";
import { getDailyBalance, getMonthlyTotals } from "../reports/reports.service.js";
import { getDebtOutstanding } from "../wealth/debt-outstanding.js";
import { averageMonthlyCost } from "../wealth/wealth.service.js";

const ZERO = new Prisma.Decimal(0);

/** Savings target when the user hasn't set one (the app's 20–30% band floor). */
export const DEFAULT_TARGET_PERCENT = 20;
/** A debt at or above this monthly rate is paid off before saving. */
export const EXPENSIVE_DEBT_MONTHLY_RATE = 3;
/** Emergency reserve considered complete, in months of cost of living. */
export const RESERVE_TARGET_MONTHS = 6;
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
 * Where the money saved this month should go first — the classic order:
 * expensive debt, then a 6-month emergency reserve, then investing.
 */
async function suggestDestination(userId: string, today: Date) {
  const debts = await prisma.debt.findMany({ where: { userId, status: { not: "paga" } } });
  const expensive = debts
    .map((debt) => ({ debt, outstanding: getDebtOutstanding(debt, today) }))
    .filter(({ debt, outstanding }) => {
      if (outstanding.value.isZero()) return false;
      const rate = debt.monthlyInterestRate ? Number(debt.monthlyInterestRate) : null;
      return rate != null ? rate >= EXPENSIVE_DEBT_MONTHLY_RATE : debt.type === "cartao_vencido" || debt.type === "cheque_especial";
    })
    .sort((a, b) => Number(b.debt.monthlyInterestRate ?? 99) - Number(a.debt.monthlyInterestRate ?? 99));

  if (expensive.length > 0) {
    const { debt, outstanding } = expensive[0];
    const rate = debt.monthlyInterestRate ? `${Number(debt.monthlyInterestRate).toString().replace(".", ",")}% ao mês` : "juros altos";
    return {
      kind: "divida" as const,
      title: `Quitar ${debt.creditor}`,
      detail: `Dívida cara (${rate}): cada real que você paga nela rende mais que qualquer investimento. Falta ${outstanding.value.toFixed(2)}.`,
    };
  }

  const reserveAccounts = await prisma.account.findMany({ where: { userId, isArchived: false, type: "savings_reserve" } });
  let reserve = ZERO;
  for (const account of reserveAccounts) reserve = reserve.plus(await getAccountBalance(userId, account.id, today));
  const avgCost = await averageMonthlyCost(userId, today);
  // Without past spending there's no cost of living to size the reserve
  // against — never claim it's complete; building it is still the next step.
  if (!avgCost || avgCost.isZero()) {
    return {
      kind: "reserva" as const,
      title: "Reserva de emergência",
      detail: `Ainda não há meses completos de gastos para medir a reserva. O ideal é guardar ${RESERVE_TARGET_MONTHS} meses do seu custo de vida antes de investir.`,
    };
  }
  const months = reserve.dividedBy(avgCost);
  if (months.lessThan(RESERVE_TARGET_MONTHS)) {
    const missing = avgCost.times(RESERVE_TARGET_MONTHS).minus(reserve);
    return {
      kind: "reserva" as const,
      title: "Reserva de emergência",
      detail: `Ela cobre ${months.toFixed(1).replace(".", ",")} meses; o ideal são ${RESERVE_TARGET_MONTHS}. Faltam ${missing.toFixed(2)}.`,
    };
  }
  return {
    kind: "investir" as const,
    title: "Investimentos e metas",
    detail: "Sem dívidas caras e com a reserva completa: o que sobrar pode render para seus objetivos.",
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

  const fraction = numDays > 0 ? elapsedDays / numDays : 0;
  const [overspending, destino] = await Promise.all([
    elapsedDays > 0 && faltaParaMeta.greaterThan(0) ? topOverspending(userId, year, month, fraction) : Promise.resolve([]),
    suggestDestination(userId, today),
  ]);

  const money = (d: Prisma.Decimal) => d.toFixed(2);
  return {
    year,
    month,
    isPast,
    isFuture,
    entradas: money(entradas),
    saidas: money(saidas),
    cartao: money(cartao),
    diarioReal: money(diarioReal),
    diarioPrevisto: money(diarioPrevisto),
    economiaFeita: money(economiaFeita),
    sobraProjetada: money(sobraProjetada),
    menorSaldoProjetado: minSaldo ? money(minSaldo) : null,
    folga: money(folga),
    podeGuardarAgora: money(podeGuardarAgora),
    limitadoPor: limitedBy,
    totalPossivel: money(totalPossivel),
    percentPossivel: pct(totalPossivel, entradas).toFixed(1),
    metaPercent: metaPercent.toFixed(0),
    metaValor: money(metaValor),
    faltaParaMeta: money(faltaParaMeta),
    overspending,
    destino,
  };
}
