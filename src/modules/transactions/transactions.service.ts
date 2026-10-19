import type { AccountType, Prisma, TransactionType } from "@prisma/client";
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
  assetId?: string | null;
}

/** Exported so recurring-transactions.service.ts can reuse the same account/transfer rules without duplicating them. */
export async function validateAccounts(
  userId: string,
  input: { accountId: string; type: TransactionType; counterpartAccountId?: string }
) {
  await getOwnedAccount(userId, input.accountId);

  const isTransfer = TRANSFER_TYPES.includes(input.type);
  if (!input.counterpartAccountId) {
    // A transfer without a destination would take the money out of the
    // patrimônio entirely instead of moving it.
    if (isTransfer) throw AppError.badRequest(`counterpartAccountId is required for type '${input.type}'`);
    return;
  }
  if (!isTransfer) {
    throw AppError.badRequest("counterpartAccountId is only valid for type 'economia' or 'transferencia'");
  }
  if (input.counterpartAccountId === input.accountId) {
    throw AppError.badRequest("counterpartAccountId cannot equal accountId");
  }
  const destination = await getOwnedAccount(userId, input.counterpartAccountId);
  if (input.type === "economia" && !SAVINGS_DESTINATIONS.includes(destination.type)) {
    throw AppError.badRequest("economia must go to a reserva or investimento account — use 'transferencia' for other moves");
  }
}

async function validateAsset(userId: string, input: { type: TransactionType; assetId?: string | null }) {
  if (!input.assetId) return;
  if (input.type !== "saida") throw AppError.badRequest("assetId is only valid on a saída (the money that bought the bem)");
  const asset = await prisma.asset.findUnique({ where: { id: input.assetId } });
  if (!asset || asset.userId !== userId) throw AppError.badRequest("assetId must be one of your bens");
}

/** Types that move money between two of the user's own accounts. */
export const TRANSFER_TYPES: TransactionType[] = ["economia", "transferencia"];
/** Where "guardar" (economia) can put money. */
const SAVINGS_DESTINATIONS: AccountType[] = ["savings_reserve", "investment"];

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
  await validateAsset(userId, input);
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
      assetId: input.assetId ?? undefined,
    },
  });
}

/**
 * `scope: "future"` only does something special when this transaction is
 * part of a recurring series: the fields that actually changed on this
 * occurrence are also applied to every later one (by `occurrenceIndex`, as
 * in deleteTransaction), leaving past occurrences — and fields left
 * untouched, which a later occurrence may have had edited on its own — as
 * they were. A date change shifts each later occurrence by the same number
 * of days. Otherwise it just updates the one row.
 */
export async function updateTransaction(
  userId: string,
  transactionId: string,
  input: Partial<Omit<TransactionInput, "categoryId">> & { categoryId?: string | null },
  scope: "this" | "future" = "this"
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
  merged.assetId = input.assetId !== undefined ? input.assetId : existing.assetId;
  if (merged.type !== "saida" && input.assetId === undefined) merged.assetId = null;
  // Turning a transfer into a plain lançamento drops its destination.
  if (input.counterpartAccountId === undefined && !TRANSFER_TYPES.includes(merged.type)) {
    merged.counterpartAccountId = undefined;
  }
  await validateAccounts(userId, merged);
  await validateAsset(userId, merged);

  const data = {
    accountId: merged.accountId,
    counterpartAccountId: merged.counterpartAccountId ?? null,
    type: merged.type,
    amount: merged.amount,
    categoryId: merged.categoryId ?? null,
    description: merged.description,
    date: merged.date,
    assetId: merged.assetId ?? null,
  };

  if (scope !== "future" || !existing.recurringTransactionId || existing.occurrenceIndex == null) {
    return prisma.transaction.update({ where: { id: transactionId }, data });
  }

  const changed: Prisma.TransactionUncheckedUpdateManyInput = {};
  if (data.accountId !== existing.accountId) changed.accountId = data.accountId;
  if (data.counterpartAccountId !== existing.counterpartAccountId) changed.counterpartAccountId = data.counterpartAccountId;
  if (data.type !== existing.type) changed.type = data.type;
  if (!existing.amount.equals(data.amount)) changed.amount = data.amount;
  if (data.categoryId !== existing.categoryId) changed.categoryId = data.categoryId;
  if ((data.description ?? null) !== existing.description) changed.description = data.description ?? null;
  const dayShift = Math.round((data.date.getTime() - existing.date.getTime()) / 86_400_000);

  const later = {
    userId,
    recurringTransactionId: existing.recurringTransactionId,
    occurrenceIndex: { gt: existing.occurrenceIndex },
  };
  const [updated] = await prisma.$transaction([
    prisma.transaction.update({ where: { id: transactionId }, data }),
    prisma.transaction.updateMany({ where: later, data: changed }),
    ...(dayShift !== 0
      ? [
          prisma.$executeRaw`
            UPDATE transactions SET date = date + ${dayShift}::int, updated_at = now()
            WHERE user_id = ${userId}
              AND recurring_transaction_id = ${existing.recurringTransactionId}
              AND occurrence_index > ${existing.occurrenceIndex}`,
        ]
      : []),
  ]);
  return updated;
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
