import { Prisma } from "@prisma/client";
import { prisma } from "../core/db/prisma.js";
import { getTotalBalance } from "../modules/reports/reports.service.js";

const ZERO = new Prisma.Decimal(0);

export interface ProjectionDay {
  date: string;
  balance: string;
  deficit: boolean;
}

export interface SavingsImpact {
  entradas: string;
  economiaBefore: string;
  economiaAfter: string;
  percentBefore: string;
  percentAfter: string;
}

export interface ProjectionResult {
  before: ProjectionDay[];
  after: ProjectionDay[];
  deficitDaysBefore: number;
  deficitDaysAfter: number;
  savingsImpact: SavingsImpact;
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function eachDay(from: Date, to: Date): Date[] {
  const days: Date[] = [];
  for (let d = new Date(from); d <= to; d = new Date(d.getTime() + 86_400_000)) {
    days.push(new Date(d));
  }
  return days;
}

async function realDailyDeltas(userId: string, from: Date, to: Date): Promise<Map<string, Prisma.Decimal>> {
  const deltas = new Map<string, Prisma.Decimal>();

  const transactions = await prisma.transaction.findMany({ where: { userId, date: { gte: from, lte: to } } });
  for (const t of transactions) {
    const key = dateKey(t.date);
    const current = deltas.get(key) ?? ZERO;
    const amount = new Prisma.Decimal(t.amount);
    if (t.type === "entrada") deltas.set(key, current.plus(amount));
    else if (t.type === "saida" || t.type === "diario") deltas.set(key, current.minus(amount));
    else if (t.type === "economia" && !t.counterpartAccountId) deltas.set(key, current.minus(amount));
  }

  const payments = await prisma.invoicePayment.findMany({
    where: { invoice: { userId }, paymentDate: { gte: from, lte: to } },
  });
  for (const p of payments) {
    const key = dateKey(p.paymentDate);
    deltas.set(key, (deltas.get(key) ?? ZERO).minus(new Prisma.Decimal(p.amount)));
  }

  return deltas;
}

async function scenarioDailyDeltas(scenarioId: string, from: Date, to: Date): Promise<Map<string, Prisma.Decimal>> {
  const deltas = new Map<string, Prisma.Decimal>();

  const transactions = await prisma.scenarioTransaction.findMany({
    where: { scenarioId, date: { gte: from, lte: to } },
  });
  for (const t of transactions) {
    const key = dateKey(t.date);
    const current = deltas.get(key) ?? ZERO;
    const amount = new Prisma.Decimal(t.amount);
    if (t.type === "entrada") deltas.set(key, current.plus(amount));
    else if (t.type === "saida" || t.type === "diario") deltas.set(key, current.minus(amount));
    else if (t.type === "economia" && !t.counterpartAccountId) deltas.set(key, current.minus(amount));
  }

  const payments = await prisma.scenarioInvoicePayment.findMany({
    where: { scenarioId, paymentDate: { gte: from, lte: to } },
  });
  const explicitlyCoveredPeriods = new Set<string>();
  for (const p of payments) {
    const key = dateKey(p.paymentDate);
    deltas.set(key, (deltas.get(key) ?? ZERO).minus(new Prisma.Decimal(p.amount)));
    if (p.cardId && p.periodYear && p.periodMonth) {
      explicitlyCoveredPeriods.add(`${p.cardId}:${p.periodYear}:${p.periodMonth}`);
    }
  }

  // An installment from a scenario purchase assumes it gets paid in full on its
  // due date, unless the user already modeled an explicit payment for that
  // card+period (avoiding double-counting the same projected outflow).
  const installments = await prisma.scenarioInstallment.findMany({
    where: { scenarioPurchase: { scenarioId }, dueDate: { gte: from, lte: to } },
  });
  for (const installment of installments) {
    const periodKey = `${installment.cardId}:${installment.periodYear}:${installment.periodMonth}`;
    if (explicitlyCoveredPeriods.has(periodKey)) continue;
    const key = dateKey(installment.dueDate);
    deltas.set(key, (deltas.get(key) ?? ZERO).minus(new Prisma.Decimal(installment.amount)));
  }

  return deltas;
}

function buildSeries(startingBalance: Prisma.Decimal, from: Date, to: Date, deltas: Map<string, Prisma.Decimal>): ProjectionDay[] {
  let balance = startingBalance;
  return eachDay(from, to).map((day) => {
    balance = balance.plus(deltas.get(dateKey(day)) ?? ZERO);
    return { date: dateKey(day), balance: balance.toFixed(2), deficit: balance.isNegative() };
  });
}

export async function projectScenario(userId: string, scenarioId: string, from: Date, to: Date): Promise<ProjectionResult> {
  const dayBeforeFrom = new Date(from.getTime() - 86_400_000);
  const startingBalance = await getTotalBalance(userId, dayBeforeFrom);

  const realDeltas = await realDailyDeltas(userId, from, to);
  const scenarioDeltas = await scenarioDailyDeltas(scenarioId, from, to);

  const combinedDeltas = new Map(realDeltas);
  for (const [key, value] of scenarioDeltas) {
    combinedDeltas.set(key, (combinedDeltas.get(key) ?? ZERO).plus(value));
  }

  const before = buildSeries(startingBalance, from, to, realDeltas);
  const after = buildSeries(startingBalance, from, to, combinedDeltas);

  const [entradas, economiaBefore, economiaAfter] = await Promise.all([
    sumTransactionType(userId, from, to, "entrada"),
    sumTransactionType(userId, from, to, "economia"),
    sumTransactionType(userId, from, to, "economia").then(async (real) => {
      const scenario = await prisma.scenarioTransaction.aggregate({
        _sum: { amount: true },
        where: { scenarioId, type: "economia", date: { gte: from, lte: to } },
      });
      return real.plus(scenario._sum.amount ?? 0);
    }),
  ]);

  const percentBefore = entradas.isZero() ? ZERO : economiaBefore.dividedBy(entradas).times(100);
  const percentAfter = entradas.isZero() ? ZERO : economiaAfter.dividedBy(entradas).times(100);

  return {
    before,
    after,
    deficitDaysBefore: before.filter((d) => d.deficit).length,
    deficitDaysAfter: after.filter((d) => d.deficit).length,
    savingsImpact: {
      entradas: entradas.toFixed(2),
      economiaBefore: economiaBefore.toFixed(2),
      economiaAfter: economiaAfter.toFixed(2),
      percentBefore: percentBefore.toFixed(2),
      percentAfter: percentAfter.toFixed(2),
    },
  };
}

async function sumTransactionType(userId: string, from: Date, to: Date, type: "entrada" | "economia") {
  const result = await prisma.transaction.aggregate({
    _sum: { amount: true },
    where: { userId, type, date: { gte: from, lte: to } },
  });
  return new Prisma.Decimal(result._sum.amount ?? 0);
}
