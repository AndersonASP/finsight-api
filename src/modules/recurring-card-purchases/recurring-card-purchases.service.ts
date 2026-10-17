import { prisma } from "../../core/db/prisma.js";
import { AppError } from "../../core/http/errors.js";
import {
  generateRecurringCardPurchaseOccurrences,
  MAX_OCCURRENCE_COUNT,
  OPEN_ENDED_OCCURRENCE_COUNT,
} from "../../services/recurring-card-purchase-generator.service.js";
import { createPurchaseInTx } from "../purchases/purchases.service.js";

export interface CreateRecurringCardPurchaseInput {
  cardId: string;
  description: string;
  amount: string;
  startDate: Date;
  occurrenceCount?: number;
  isOpenEnded?: boolean;
  categoryId?: string;
}

/**
 * A subscription that charges the card the same amount every month (e.g.
 * Netflix) — eagerly materializes a real `Purchase` (and its single
 * installment) for every occurrence, reusing `createPurchaseInTx` so each one
 * lands on the right invoice exactly like a normal card purchase would.
 */
export async function createRecurringCardPurchase(userId: string, input: CreateRecurringCardPurchaseInput) {
  const card = await prisma.card.findUnique({ where: { id: input.cardId } });
  if (!card || card.userId !== userId) throw AppError.notFound("Card not found");

  const occurrenceCount = Math.min(
    input.isOpenEnded ? OPEN_ENDED_OCCURRENCE_COUNT : (input.occurrenceCount ?? 1),
    MAX_OCCURRENCE_COUNT
  );
  if (occurrenceCount < 1) {
    throw AppError.badRequest("occurrenceCount must be at least 1");
  }

  const occurrences = generateRecurringCardPurchaseOccurrences({
    startDate: input.startDate,
    occurrenceCount,
  });

  return prisma.$transaction(async (tx) => {
    const recurring = await tx.recurringCardPurchase.create({
      data: {
        userId,
        cardId: input.cardId,
        description: input.description,
        amount: input.amount,
        categoryId: input.categoryId,
        startDate: input.startDate,
        occurrenceCount,
        isOpenEnded: input.isOpenEnded ?? false,
      },
    });

    for (const occurrence of occurrences) {
      await createPurchaseInTx(tx, userId, {
        cardId: input.cardId,
        purchaseDate: occurrence.purchaseDate,
        description: input.description,
        amount: input.amount,
        categoryId: input.categoryId,
        installmentsCount: 1,
        recurringCardPurchaseId: recurring.id,
        occurrenceIndex: occurrence.occurrenceIndex,
      });
    }

    return recurring;
  });
}
