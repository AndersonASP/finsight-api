import { Prisma } from "@prisma/client";
import { prisma } from "../../core/db/prisma.js";
import { AppError } from "../../core/http/errors.js";
import { horizonFor, loadEvaluator, whatIf } from "../insights/what-if.service.js";

export interface WishlistItemInput {
  description: string;
  amount: string;
  pixDiscountPercent?: number | null;
  interestFreeInstallments?: number;
}

async function getOwnedItem(userId: string, id: string) {
  const item = await prisma.wishlistItem.findUnique({ where: { id } });
  if (!item || item.userId !== userId) throw AppError.notFound("Wishlist item not found");
  return item;
}

function toData(input: Partial<WishlistItemInput>) {
  return {
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.amount !== undefined ? { amount: new Prisma.Decimal(input.amount) } : {}),
    ...(input.pixDiscountPercent !== undefined
      ? { pixDiscountPercent: input.pixDiscountPercent == null ? null : new Prisma.Decimal(input.pixDiscountPercent) }
      : {}),
    ...(input.interestFreeInstallments !== undefined ? { interestFreeInstallments: input.interestFreeInstallments } : {}),
  };
}

/**
 * Every item re-simulated today ("me ajuda a decidir"), all on one shared
 * projection: the verdict changes on its own as the month goes by, which is
 * what the app watches to say "agora cabe".
 */
export async function listWishlist(userId: string) {
  const items = await prisma.wishlistItem.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  if (items.length === 0) return [];
  const maxInstallments = Math.max(...items.map((i) => i.interestFreeInstallments));
  const evaluator = await loadEvaluator(userId, horizonFor(maxInstallments));
  return Promise.all(
    items.map(async (item) => ({
      id: item.id,
      description: item.description,
      amount: item.amount,
      pixDiscountPercent: item.pixDiscountPercent,
      interestFreeInstallments: item.interestFreeInstallments,
      createdAt: item.createdAt,
      simulacao: await whatIf(
        userId,
        {
          description: item.description,
          amount: item.amount.toFixed(2),
          payment: { method: "decide" },
          pixDiscountPercent: item.pixDiscountPercent ? Number(item.pixDiscountPercent) : undefined,
          interestFreeInstallments: item.interestFreeInstallments,
        },
        evaluator
      ),
    }))
  );
}

export async function createWishlistItem(userId: string, input: WishlistItemInput) {
  return prisma.wishlistItem.create({
    data: { userId, description: input.description, amount: new Prisma.Decimal(input.amount), ...toData(input) },
  });
}

export async function updateWishlistItem(userId: string, id: string, input: Partial<WishlistItemInput>) {
  await getOwnedItem(userId, id);
  return prisma.wishlistItem.update({ where: { id }, data: toData(input) });
}

export async function deleteWishlistItem(userId: string, id: string) {
  await getOwnedItem(userId, id);
  await prisma.wishlistItem.delete({ where: { id } });
}
