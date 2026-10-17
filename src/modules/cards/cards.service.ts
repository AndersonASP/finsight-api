import { prisma } from "../../core/db/prisma.js";
import { AppError } from "../../core/http/errors.js";
import { getOwnedAccount } from "../accounts/accounts.service.js";

export interface CardInput {
  name: string;
  brand?: string;
  closingDay: number;
  dueDay: number;
  defaultPaymentAccountId: string;
}

export async function getOwnedCard(userId: string, cardId: string) {
  const card = await prisma.card.findUnique({ where: { id: cardId } });
  if (!card || card.userId !== userId) throw AppError.notFound("Card not found");
  return card;
}

export async function listCards(userId: string) {
  return prisma.card.findMany({ where: { userId, isArchived: false }, orderBy: { createdAt: "asc" } });
}

export async function createCard(userId: string, input: CardInput) {
  await getOwnedAccount(userId, input.defaultPaymentAccountId);
  validateDays(input.closingDay, input.dueDay);

  return prisma.card.create({
    data: {
      userId,
      name: input.name,
      brand: input.brand,
      closingDay: input.closingDay,
      dueDay: input.dueDay,
      defaultPaymentAccountId: input.defaultPaymentAccountId,
    },
  });
}

export async function updateCard(userId: string, cardId: string, input: Partial<CardInput> & { isArchived?: boolean }) {
  await getOwnedCard(userId, cardId);
  if (input.defaultPaymentAccountId) await getOwnedAccount(userId, input.defaultPaymentAccountId);
  if (input.closingDay !== undefined || input.dueDay !== undefined) {
    const current = await getOwnedCard(userId, cardId);
    validateDays(input.closingDay ?? current.closingDay, input.dueDay ?? current.dueDay);
  }
  return prisma.card.update({ where: { id: cardId }, data: input });
}

export async function deleteCard(userId: string, cardId: string) {
  await getOwnedCard(userId, cardId);
  await prisma.card.delete({ where: { id: cardId } });
}

function validateDays(closingDay: number, dueDay: number) {
  if (closingDay < 1 || closingDay > 31) throw AppError.badRequest("closingDay must be between 1 and 31");
  if (dueDay < 1 || dueDay > 31) throw AppError.badRequest("dueDay must be between 1 and 31");
}
