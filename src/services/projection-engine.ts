import { Prisma, type AccountType, type TransactionType } from "@prisma/client";
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

type AccountTypes = Map<string, AccountType>;

async function accountTypesOf(userId: string): Promise<AccountTypes> {
  const accounts = await prisma.account.findMany({ where: { userId }, select: { id: true, type: true } });
  return new Map(accounts.map((a) => [a.id, a.type]));
}

/**
 * How a lançamento moves the checking pool — the same pool the starting
 * balance (getTotalBalance) measures: money leaving or entering a checking
 * account, and a transfer (economia/transferencia) arriving in one.
 */
function checkingDelta(
  t: { type: TransactionType; amount: Prisma.Decimal.Value; accountId: string; counterpartAccountId: string | null },
  types: AccountTypes
) {
  const amount = new Prisma.Decimal(t.amount);
  let delta = ZERO;
  if (types.get(t.accountId) === "checking") delta = t.type === "entrada" ? amount : amount.negated();
  if (t.counterpartAccountId && types.get(t.counterpartAccountId) === "checking") delta = delta.plus(amount);
  return delta;
}

async function realDailyDeltas(userId: string, from: Date, to: Date, types: AccountTypes): Promise<Map<string, Prisma.Decimal>> {
  const deltas = new Map<string, Prisma.Decimal>();

  const transactions = await prisma.transaction.findMany({ where: { userId, date: { gte: from, lte: to } } });
  for (const t of transactions) {
    const key = dateKey(t.date);
    deltas.set(key, (deltas.get(key) ?? ZERO).plus(checkingDelta(t, types)));
  }

  // The bill debits automatically in full on each installment's due date
  // (see accounts.service.ts's getAccountBalance) — no manual payment to sum here.
  const installmentsDue = await prisma.installment.findMany({
    where: { purchase: { userId }, dueDate: { gte: from, lte: to } },
  });
  for (const installment of installmentsDue) {
    const key = dateKey(installment.dueDate);
    deltas.set(key, (deltas.get(key) ?? ZERO).minus(new Prisma.Decimal(installment.amount)));
  }

  return deltas;
}

async function scenarioDailyDeltas(scenarioId: string, from: Date, to: Date, types: AccountTypes): Promise<Map<string, Prisma.Decimal>> {
  const deltas = new Map<string, Prisma.Decimal>();

  const transactions = await prisma.scenarioTransaction.findMany({
    where: { scenarioId, date: { gte: from, lte: to } },
  });
  for (const t of transactions) {
    const key = dateKey(t.date);
    deltas.set(key, (deltas.get(key) ?? ZERO).plus(checkingDelta(t, types)));
  }

  // An installment from a scenario purchase debits in full on its due date —
  // same rule as a real installment (see accounts.service.ts), no simulated
  // invoice payment to avoid double-counting against since the real world
  // doesn't have one either.
  const installments = await prisma.scenarioInstallment.findMany({
    where: { scenarioPurchase: { scenarioId }, dueDate: { gte: from, lte: to } },
  });
  for (const installment of installments) {
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

  const types = await accountTypesOf(userId);
  const realDeltas = await realDailyDeltas(userId, from, to, types);
  const scenarioDeltas = await scenarioDailyDeltas(scenarioId, from, to, types);

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
