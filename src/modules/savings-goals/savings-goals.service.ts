import { Prisma, type SavingsGoalPeriodType } from "@prisma/client";
import { prisma } from "../../core/db/prisma.js";
import { AppError } from "../../core/http/errors.js";
import { daysInMonth } from "../../core/http/date.js";

const ZERO = new Prisma.Decimal(0);

export interface SavingsGoalInput {
  periodType: SavingsGoalPeriodType;
  periodYear: number;
  periodMonth?: number;
  targetPercent: string;
  methodologyNote?: string;
}

async function getOwnedSavingsGoal(userId: string, goalId: string) {
  const goal = await prisma.savingsGoal.findUnique({ where: { id: goalId } });
  if (!goal || goal.userId !== userId) throw AppError.notFound("Savings goal not found");
  return goal;
}

function validateInput(input: Pick<SavingsGoalInput, "periodType" | "periodMonth" | "targetPercent">) {
  if (input.periodType === "monthly" && !input.periodMonth) {
    throw AppError.badRequest("periodMonth is required for a monthly goal");
  }
  const percent = new Prisma.Decimal(input.targetPercent);
  if (percent.lessThanOrEqualTo(0) || percent.greaterThan(100)) {
    throw AppError.badRequest("targetPercent must be between 0 and 100");
  }
}

export async function listSavingsGoals(userId: string) {
  return prisma.savingsGoal.findMany({ where: { userId }, orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }] });
}

export async function createSavingsGoal(userId: string, input: SavingsGoalInput) {
  validateInput(input);
  return prisma.savingsGoal.create({
    data: {
      userId,
      periodType: input.periodType,
      periodYear: input.periodYear,
      periodMonth: input.periodType === "monthly" ? input.periodMonth : null,
      targetPercent: input.targetPercent,
      methodologyNote: input.methodologyNote,
    },
  });
}

export async function updateSavingsGoal(userId: string, goalId: string, input: Partial<SavingsGoalInput>) {
  const existing = await getOwnedSavingsGoal(userId, goalId);
  const merged = {
    periodType: input.periodType ?? existing.periodType,
    periodMonth: input.periodMonth ?? existing.periodMonth ?? undefined,
    targetPercent: input.targetPercent ?? existing.targetPercent.toString(),
  };
  validateInput(merged);
  return prisma.savingsGoal.update({ where: { id: goalId }, data: input });
}

function periodRange(periodType: SavingsGoalPeriodType, periodYear: number, periodMonth: number | null) {
  if (periodType === "monthly") {
    const month = periodMonth!;
    return {
      from: new Date(Date.UTC(periodYear, month - 1, 1)),
      to: new Date(Date.UTC(periodYear, month, 1)),
      totalDays: daysInMonth(periodYear, month),
    };
  }
  const from = new Date(Date.UTC(periodYear, 0, 1));
  const to = new Date(Date.UTC(periodYear + 1, 0, 1));
  const totalDays = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  return { from, to, totalDays };
}

function elapsedDays(from: Date, to: Date, totalDays: number): number {
  const today = new Date();
  if (today < from) return 0;
  if (today >= to) return totalDays;
  return Math.max(1, Math.ceil((today.getTime() - from.getTime()) / 86_400_000));
}

/**
 * Computes the three concepts RF-14 asks to be kept distinct:
 *  - "economia de caixa" (realized): every `economia` transaction in the
 *    period — this drives `realizedPercent`/`forecastPercent`.
 *  - "transferência para reserva": the subset of that total that moved into a
 *    `savings_reserve` account, shown separately for transparency.
 *  - "variação patrimonial": the change in `investment` account snapshots —
 *    market/passive gains, never folded into the percentage above.
 */
export async function getProgress(userId: string, goalId: string) {
  const goal = await getOwnedSavingsGoal(userId, goalId);
  const { from, to, totalDays } = periodRange(goal.periodType, goal.periodYear, goal.periodMonth);
  const elapsed = elapsedDays(from, to, totalDays);

  const [entradasAgg, economiaTransactions, investmentAccounts] = await Promise.all([
    prisma.transaction.aggregate({ _sum: { amount: true }, where: { userId, type: "entrada", date: { gte: from, lt: to } } }),
    prisma.transaction.findMany({
      where: { userId, type: "economia", date: { gte: from, lt: to } },
      include: { counterpartAccount: true },
    }),
    prisma.account.findMany({ where: { userId, type: "investment" } }),
  ]);

  const entradas = new Prisma.Decimal(entradasAgg._sum.amount ?? 0);

  let cashSavings = ZERO;
  let transferToReserve = ZERO;
  for (const t of economiaTransactions) {
    const amount = new Prisma.Decimal(t.amount);
    cashSavings = cashSavings.plus(amount);
    if (t.counterpartAccount?.type === "savings_reserve") {
      transferToReserve = transferToReserve.plus(amount);
    }
  }

  let patrimonioVariation = ZERO;
  for (const account of investmentAccounts) {
    const [startSnapshot, endSnapshot] = await Promise.all([
      prisma.accountBalanceSnapshot.findFirst({ where: { accountId: account.id, snapshotDate: { lt: from } }, orderBy: { snapshotDate: "desc" } }),
      prisma.accountBalanceSnapshot.findFirst({ where: { accountId: account.id, snapshotDate: { lt: to } }, orderBy: { snapshotDate: "desc" } }),
    ]);
    const startBalance = new Prisma.Decimal(startSnapshot?.balance ?? account.initialBalance);
    const endBalance = new Prisma.Decimal(endSnapshot?.balance ?? account.initialBalance);
    patrimonioVariation = patrimonioVariation.plus(endBalance.minus(startBalance));
  }

  const realizedPercent = entradas.isZero() ? ZERO : cashSavings.dividedBy(entradas).times(100);
  // Run-rate forecast: extrapolate savings-so-far to the full period, holding
  // income received so far constant (income is usually a fixed salary that
  // lands early, unlike discretionary savings which accrue through the period).
  const forecastedCashSavings = elapsed > 0 ? cashSavings.dividedBy(elapsed).times(totalDays) : ZERO;
  const forecastPercent = entradas.isZero() ? ZERO : forecastedCashSavings.dividedBy(entradas).times(100);

  return {
    goal,
    realizedPercent: realizedPercent.toFixed(2),
    forecastPercent: forecastPercent.toFixed(2),
    cashSavingsAmount: cashSavings.toFixed(2),
    transferToReserveAmount: transferToReserve.toFixed(2),
    patrimonioVariationAmount: patrimonioVariation.toFixed(2),
    entradas: entradas.toFixed(2),
    methodology:
      "realizedPercent = economia de caixa (todas as transações tipo economia) / entradas no período. " +
      "forecastPercent extrapola a economia realizada até hoje para o período inteiro, mantendo as entradas atuais fixas. " +
      "transferToReserveAmount é o subconjunto da economia de caixa que foi transferido para uma conta de reserva. " +
      "patrimonioVariationAmount (variação em contas de investimento) nunca entra nas porcentagens acima.",
  };
}

export async function deleteSavingsGoal(userId: string, goalId: string) {
  await getOwnedSavingsGoal(userId, goalId);
  await prisma.savingsGoal.delete({ where: { id: goalId } });
}
