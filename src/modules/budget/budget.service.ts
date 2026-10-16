import { Prisma } from "@prisma/client";
import { prisma } from "../../core/db/prisma.js";
import { AppError } from "../../core/http/errors.js";
import { daysInMonth } from "../../core/http/date.js";

export interface BudgetItemInput {
  name: string;
  amount: string;
  categoryId?: string;
  active?: boolean;
  startsOn?: Date;
  endsOn?: Date;
}

async function getOwnedBudgetItem(userId: string, budgetItemId: string) {
  const item = await prisma.budgetItem.findUnique({ where: { id: budgetItemId } });
  if (!item || item.userId !== userId) throw AppError.notFound("Budget item not found");
  return item;
}

export async function listBudgetItems(userId: string) {
  return prisma.budgetItem.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
}

export async function createBudgetItem(userId: string, input: BudgetItemInput) {
  return prisma.budgetItem.create({ data: { userId, ...input } });
}

export async function updateBudgetItem(userId: string, budgetItemId: string, input: Partial<BudgetItemInput>) {
  await getOwnedBudgetItem(userId, budgetItemId);
  return prisma.budgetItem.update({ where: { id: budgetItemId }, data: input });
}

export async function deleteBudgetItem(userId: string, budgetItemId: string) {
  await getOwnedBudgetItem(userId, budgetItemId);
  await prisma.budgetItem.delete({ where: { id: budgetItemId } });
}

/** Matches the reference app's "previsão de diário": sum of active budget items / days in month. */
export async function getBudgetSummary(userId: string, year: number, month: number) {
  const items = await prisma.budgetItem.findMany({ where: { userId, active: true } });
  const total = items.reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0));
  const days = daysInMonth(year, month);
  const dailyAverage = days > 0 ? total.dividedBy(days) : new Prisma.Decimal(0);

  return { total: total.toFixed(2), days, dailyAverage: dailyAverage.toFixed(2) };
}
