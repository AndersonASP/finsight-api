import type { TransactionType } from "@prisma/client";
import { prisma } from "../../core/db/prisma.js";
import { AppError } from "../../core/http/errors.js";
import { getOwnedAccount } from "../accounts/accounts.service.js";

export interface TransactionInput {
  accountId: string;
  type: TransactionType;
  amount: string;
  date: Date;
  categoryId?: string;
  description?: string;
  counterpartAccountId?: string;
}

/** Exported so recurring-transactions.service.ts can reuse the same account/transfer rules without duplicating them. */
export async function validateAccounts(
  userId: string,
  input: { accountId: string; type: TransactionType; counterpartAccountId?: string }
) {
  await getOwnedAccount(userId, input.accountId);

  if (input.counterpartAccountId) {
    if (input.type !== "economia") {
      throw AppError.badRequest("counterpartAccountId is only valid for type 'economia' (a transfer)");
    }
    if (input.counterpartAccountId === input.accountId) {
      throw AppError.badRequest("counterpartAccountId cannot equal accountId");
    }
    await getOwnedAccount(userId, input.counterpartAccountId);
  }
}

async function getOwnedTransaction(userId: string, transactionId: string) {
  const transaction = await prisma.transaction.findUnique({ where: { id: transactionId } });
  if (!transaction || transaction.userId !== userId) throw AppError.notFound("Transaction not found");
  return transaction;
}

export async function getTransaction(userId: string, transactionId: string) {
  return getOwnedTransaction(userId, transactionId);
}

/** Toggles the visual "pago" check. Doesn't touch amount/date, so balances are unaffected. */
export async function setTransactionPaid(userId: string, transactionId: string, paid: boolean) {
  await getOwnedTransaction(userId, transactionId);
  return prisma.transaction.update({ where: { id: transactionId }, data: { paidAt: paid ? new Date() : null } });
}

export interface ListTransactionsFilter {
  from?: Date;
  to?: Date;
  type?: TransactionType;
  categoryId?: string;
  accountId?: string;
}

export async function listTransactions(userId: string, filter: ListTransactionsFilter) {
  return prisma.transaction.findMany({
    where: {
      userId,
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.categoryId ? { categoryId: filter.categoryId } : {}),
      ...(filter.accountId ? { accountId: filter.accountId } : {}),
      ...(filter.from || filter.to
        ? { date: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
        : {}),
    },
    orderBy: { date: "desc" },
    include: { category: true },
  });
}

export async function createTransaction(userId: string, input: TransactionInput) {
  await validateAccounts(userId, input);
  return prisma.transaction.create({
    data: {
      userId,
      accountId: input.accountId,
      counterpartAccountId: input.counterpartAccountId,
      type: input.type,
      amount: input.amount,
      categoryId: input.categoryId,
      description: input.description,
      date: input.date,
    },
  });
}

export async function updateTransaction(
  userId: string,
  transactionId: string,
  input: Partial<Omit<TransactionInput, "categoryId">> & { categoryId?: string | null }
) {
  const existing = await getOwnedTransaction(userId, transactionId);
  const merged: TransactionInput = {
    accountId: input.accountId ?? existing.accountId,
    type: input.type ?? existing.type,
    amount: input.amount ?? existing.amount.toString(),
    date: input.date ?? existing.date,
    categoryId: input.categoryId !== undefined ? (input.categoryId ?? undefined) : (existing.categoryId ?? undefined),
    description: input.description !== undefined ? input.description : (existing.description ?? undefined),
    counterpartAccountId:
      input.counterpartAccountId !== undefined
        ? input.counterpartAccountId
        : (existing.counterpartAccountId ?? undefined),
  };
  await validateAccounts(userId, merged);

  return prisma.transaction.update({
    where: { id: transactionId },
    data: {
      accountId: merged.accountId,
      counterpartAccountId: merged.counterpartAccountId ?? null,
      type: merged.type,
      amount: merged.amount,
      categoryId: merged.categoryId ?? null,
      description: merged.description,
      date: merged.date,
    },
  });
}

/**
 * `scope: "future"` only does something special when this transaction is
 * part of a recurring series: it removes this occurrence and every later
 * one in the same series (by `occurrenceIndex`, not by date — an occurrence
 * may have had its date edited since it was generated), leaving past
 * occurrences untouched. Otherwise (or for a non-recurring transaction) it
 * just deletes the one row, same as before.
 */
export async function deleteTransaction(userId: string, transactionId: string, scope: "this" | "future" = "this") {
  const existing = await getOwnedTransaction(userId, transactionId);
  if (scope === "future" && existing.recurringTransactionId && existing.occurrenceIndex != null) {
    await prisma.transaction.deleteMany({
      where: {
        userId,
        recurringTransactionId: existing.recurringTransactionId,
        occurrenceIndex: { gte: existing.occurrenceIndex },
      },
    });
    return;
  }
  await prisma.transaction.delete({ where: { id: transactionId } });
}
