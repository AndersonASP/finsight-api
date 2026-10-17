import { Prisma } from "@prisma/client";
import { prisma } from "../../core/db/prisma.js";
import { AppError } from "../../core/http/errors.js";
import { createPurchase } from "../purchases/purchases.service.js";
import { createTransaction } from "../transactions/transactions.service.js";

/** Wallet card names are matched case- and whitespace-insensitively. */
export function normalizeWalletName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

// ------------------------------------------------------------ mappings

export async function listMappings(userId: string) {
  return prisma.walletCardMapping.findMany({
    where: { userId },
    include: { card: { select: { id: true, name: true } }, account: { select: { id: true, name: true } } },
    orderBy: { walletName: "asc" },
  });
}

export async function upsertMapping(
  userId: string,
  input: { walletName: string; cardId?: string; accountId?: string }
) {
  if (Boolean(input.cardId) === Boolean(input.accountId)) {
    throw AppError.badRequest("Provide exactly one of cardId (crédito) or accountId (débito)");
  }
  if (input.cardId) {
    const card = await prisma.card.findUnique({ where: { id: input.cardId } });
    if (!card || card.userId !== userId) throw AppError.notFound("Card not found");
  }
  if (input.accountId) {
    const account = await prisma.account.findUnique({ where: { id: input.accountId } });
    if (!account || account.userId !== userId) throw AppError.notFound("Account not found");
  }

  const walletName = normalizeWalletName(input.walletName);
  if (!walletName) throw AppError.badRequest("walletName is required");
  const target = { cardId: input.cardId ?? null, accountId: input.accountId ?? null };
  return prisma.walletCardMapping.upsert({
    where: { userId_walletName: { userId, walletName } },
    create: { userId, walletName, ...target },
    update: target,
  });
}

export async function deleteMapping(userId: string, id: string) {
  const mapping = await prisma.walletCardMapping.findUnique({ where: { id } });
  if (!mapping || mapping.userId !== userId) throw AppError.notFound("Mapping not found");
  await prisma.walletCardMapping.delete({ where: { id } });
}

// ------------------------------------------------------------ quick entry

export interface QuickEntryInput {
  amount: string;
  merchant: string;
  cardName?: string;
  date: Date;
}

export interface QuickEntryResult {
  kind: "purchase" | "transaction";
  id: string;
  description: string;
  amount: string;
  date: string;
  categoryName: string | null;
  paymentName: string;
}

type PaymentTarget = { kind: "card"; id: string; name: string } | { kind: "account"; id: string; name: string };

/**
 * Wallet card → FinSight card/account. Falls back to the only active card
 * when there's no mapping (the common single-card setup); anything more
 * ambiguous is refused so the purchase never lands in the wrong place.
 */
async function resolvePaymentTarget(userId: string, cardName?: string): Promise<PaymentTarget> {
  if (cardName?.trim()) {
    const mapping = await prisma.walletCardMapping.findUnique({
      where: { userId_walletName: { userId, walletName: normalizeWalletName(cardName) } },
      include: { card: true, account: true },
    });
    if (mapping?.card) return { kind: "card", id: mapping.card.id, name: mapping.card.name };
    if (mapping?.account) return { kind: "account", id: mapping.account.id, name: mapping.account.name };
  }

  const cards = await prisma.card.findMany({ where: { userId, isArchived: false }, take: 2 });
  if (cards.length === 1) return { kind: "card", id: cards[0].id, name: cards[0].name };

  throw new AppError(
    422,
    "unmapped_card",
    cardName?.trim()
      ? `O cartão "${cardName.trim()}" da Carteira não está vinculado a nenhum cartão ou conta do FinSight.`
      : "Informe qual cartão foi usado — há mais de um cartão cadastrado."
  );
}

/** The tag last used for the same merchant (by exact, case-insensitive description). */
async function suggestCategory(userId: string, merchant: string) {
  const where = { userId, description: { equals: merchant, mode: "insensitive" as const }, categoryId: { not: null } };
  const [transaction, purchase] = await Promise.all([
    prisma.transaction.findFirst({ where, orderBy: { createdAt: "desc" }, include: { category: true } }),
    prisma.purchase.findFirst({ where, orderBy: { createdAt: "desc" }, include: { category: true } }),
  ]);
  const latest =
    transaction && purchase
      ? transaction.createdAt > purchase.createdAt
        ? transaction
        : purchase
      : (transaction ?? purchase);
  return latest?.category ?? null;
}

/**
 * Logs a purchase reported by an Apple Pay automation / Shortcut: on a
 * crédito card it becomes a one-installment card purchase, on a débito
 * account a "diário" lançamento — tagged like the last time at that merchant.
 */
export async function createQuickEntry(userId: string, input: QuickEntryInput): Promise<QuickEntryResult> {
  const merchant = input.merchant.trim();
  const target = await resolvePaymentTarget(userId, input.cardName);
  const category = await suggestCategory(userId, merchant);

  if (target.kind === "card") {
    const purchase = await createPurchase(userId, {
      cardId: target.id,
      purchaseDate: input.date,
      description: merchant,
      amount: input.amount,
      categoryId: category?.id,
    });
    return {
      kind: "purchase",
      id: purchase.id,
      description: merchant,
      amount: new Prisma.Decimal(input.amount).toFixed(2),
      date: input.date.toISOString().slice(0, 10),
      categoryName: category?.name ?? null,
      paymentName: target.name,
    };
  }

  const transaction = await createTransaction(userId, {
    accountId: target.id,
    type: "diario",
    amount: input.amount,
    date: input.date,
    description: merchant,
    categoryId: category?.id,
  });
  return {
    kind: "transaction",
    id: transaction.id,
    description: merchant,
    amount: new Prisma.Decimal(input.amount).toFixed(2),
    date: input.date.toISOString().slice(0, 10),
    categoryName: category?.name ?? null,
    paymentName: target.name,
  };
}
