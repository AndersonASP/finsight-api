import type { TransactionType } from "@prisma/client";
import { prisma } from "../../core/db/prisma.js";
import { AppError } from "../../core/http/errors.js";
import {
  generateRecurringOccurrences,
  MAX_OCCURRENCE_COUNT,
  occurrencesForTenYearHorizon,
  type RecurrenceInterval,
} from "../../services/recurring-transaction-generator.service.js";
import { validateAccounts } from "../transactions/transactions.service.js";

export interface CreateRecurringTransactionInput {
  accountId: string;
  type: TransactionType;
  amount: string;
  startDate: Date;
  interval: RecurrenceInterval;
  occurrenceCount?: number;
  isOpenEnded?: boolean;
  categoryId?: string;
  description?: string;
  counterpartAccountId?: string;
}

export async function createRecurringTransaction(userId: string, input: CreateRecurringTransactionInput) {
  await validateAccounts(userId, input);

  const occurrenceCount = Math.min(
    input.isOpenEnded ? occurrencesForTenYearHorizon(input.interval) : (input.occurrenceCount ?? 1),
    MAX_OCCURRENCE_COUNT
  );
  if (occurrenceCount < 1) {
    throw AppError.badRequest("occurrenceCount must be at least 1");
  }

  const occurrences = generateRecurringOccurrences({
    startDate: input.startDate,
    interval: input.interval,
    occurrenceCount,
  });

  return prisma.$transaction(async (tx) => {
    const recurring = await tx.recurringTransaction.create({
      data: {
        userId,
        accountId: input.accountId,
        counterpartAccountId: input.counterpartAccountId,
        type: input.type,
        amount: input.amount,
        categoryId: input.categoryId,
        description: input.description,
        startDate: input.startDate,
        interval: input.interval,
        occurrenceCount,
        isOpenEnded: input.isOpenEnded ?? false,
      },
    });

    await tx.transaction.createMany({
      data: occurrences.map((occurrence) => ({
        userId,
        accountId: input.accountId,
        counterpartAccountId: input.counterpartAccountId,
        type: input.type,
        amount: input.amount,
        categoryId: input.categoryId,
        description: input.description,
        date: occurrence.date,
        recurringTransactionId: recurring.id,
        occurrenceIndex: occurrence.occurrenceIndex,
      })),
    });

    return recurring;
  });
}
