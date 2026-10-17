import { prisma } from "../../core/db/prisma.js";
import { AppError } from "../../core/http/errors.js";

export interface CategoryInput {
  name: string;
  color: string;
  icon?: string;
}

async function getOwnedCategory(userId: string, categoryId: string) {
  const category = await prisma.category.findUnique({ where: { id: categoryId } });
  if (!category || category.userId !== userId) throw AppError.notFound("Category not found");
  return category;
}

export async function listCategories(userId: string) {
  return prisma.category.findMany({ where: { userId }, orderBy: { name: "asc" } });
}

export async function createCategory(userId: string, input: CategoryInput) {
  return prisma.category.create({ data: { userId, ...input } });
}

export async function updateCategory(userId: string, categoryId: string, input: Partial<CategoryInput>) {
  await getOwnedCategory(userId, categoryId);
  return prisma.category.update({ where: { id: categoryId }, data: input });
}

export async function deleteCategory(userId: string, categoryId: string) {
  await getOwnedCategory(userId, categoryId);
  await prisma.category.delete({ where: { id: categoryId } });
}

export async function getCategoryTotal(userId: string, categoryId: string, year: number, month: number) {
  await getOwnedCategory(userId, categoryId);
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));

  const result = await prisma.transaction.aggregate({
    _sum: { amount: true },
    where: { categoryId, date: { gte: from, lt: to } },
  });

  return result._sum.amount ?? 0;
}

/**
 * Moves everything tagged `fromId` — lançamentos, card purchases, their
 * recurring series, previsão de diário items and simulations — to `intoId`,
 * then deletes `fromId`. Deleting a tag alone would just untag all of it.
 */
export async function mergeCategory(userId: string, fromId: string, intoId: string) {
  if (fromId === intoId) throw AppError.badRequest("Cannot merge a tag into itself");
  await getOwnedCategory(userId, fromId);
  const into = await getOwnedCategory(userId, intoId);
  const move = { where: { categoryId: fromId }, data: { categoryId: intoId } };
  const [transactions, purchases] = await prisma.$transaction([
    prisma.transaction.updateMany(move),
    prisma.purchase.updateMany(move),
    prisma.recurringTransaction.updateMany(move),
    prisma.recurringCardPurchase.updateMany(move),
    prisma.budgetItem.updateMany(move),
    prisma.scenarioTransaction.updateMany(move),
    prisma.scenarioPurchase.updateMany(move),
    prisma.scenarioBudgetItem.updateMany(move),
    prisma.category.delete({ where: { id: fromId } }),
  ]);
  return { into, movedTransactions: transactions.count, movedPurchases: purchases.count };
}
