import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireUserId } from "../../core/http/auth-guard.js";
import { parseDateParam } from "../../core/http/date.js";
import { AppError } from "../../core/http/errors.js";
import { registerAssetPurchase, simulateAssetPurchase } from "./asset-purchase.service.js";
import { simulatePurchase } from "./purchase-simulation.service.js";
import { getSavingsCapacity } from "./savings-capacity.service.js";
import { getSummary } from "./summary.service.js";
import { whatIf } from "./what-if.service.js";

export const insightsRouter = Router();

insightsRouter.get(
  "/savings-capacity",
  asyncHandler(async (req, res) => {
    const year = Number(req.query.year);
    const month = Number(req.query.month);
    if (!year || !month || month < 1 || month > 12) {
      throw AppError.badRequest("year and month query params are required (month 1-12)");
    }
    res.json(await getSavingsCapacity(requireUserId(req), year, month));
  })
);

/** Compact figures for the home/lock screen widget. */
insightsRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    res.json(await getSummary(requireUserId(req)));
  })
);

const simulatePurchaseSchema = z.object({
  amount: z.string(),
  installments: z.number().int().min(1).max(48).optional(),
  cardId: z.string().uuid().optional(),
  /** YYYY-MM-DD; defaults to today. */
  date: z.string().optional(),
});

/** "Posso comprar?" — a what-if on the real projection; nothing is saved. */
insightsRouter.post(
  "/simulate-purchase",
  asyncHandler(async (req, res) => {
    const input = simulatePurchaseSchema.parse(req.body);
    const date = parseDateParam(input.date ?? new Date().toISOString().slice(0, 10), "date");
    res.json(await simulatePurchase(requireUserId(req), { ...input, date }));
  })
);

const whatIfSchema = z.object({
  description: z.string().trim().max(80).optional(),
  amount: z.string(),
  payment: z
    .discriminatedUnion("method", [
      z.object({ method: z.literal("pix") }),
      z.object({ method: z.literal("card"), cardId: z.string().uuid(), installments: z.number().int().min(1).max(24).default(1) }),
      z.object({ method: z.literal("decide") }),
    ])
    .default({ method: "decide" }),
  pixDiscountPercent: z.number().min(0).max(50).optional(),
  interestFreeInstallments: z.number().int().min(1).max(24).optional(),
  recurring: z.boolean().optional(),
});

/**
 * "E se?" — a purchase made today (or a monthly charge) against the real
 * projection: verdict with the reserve guardian, the best payment method
 * when asked, and plain-language text. Nothing is saved.
 */
insightsRouter.post(
  "/what-if",
  asyncHandler(async (req, res) => {
    res.json(await whatIf(requireUserId(req), whatIfSchema.parse(req.body)));
  })
);

const amount = z.string().regex(/^\d+(\.\d{1,2})?$/, "must be a non-negative amount like 1234.56");
const assetPurchaseSchema = z.object({
  description: z.string().trim().max(80).optional(),
  assetKind: z.enum(["imovel", "veiculo", "outro"]),
  producesIncome: z.boolean().optional(),
  price: amount,
  taxes: amount.optional(),
  fees: amount.optional(),
  downPayment: amount.optional(),
  downPaymentAccountId: z.string().uuid(),
  financing: z
    .object({
      installments: z.number().int().min(1).max(420),
      installmentAmount: amount,
      firstDueDate: z.string().optional(),
      principal: amount.optional(),
      installmentAccountId: z.string().uuid().optional(),
    })
    .optional(),
});

function parseAssetPurchase(body: unknown) {
  const input = assetPurchaseSchema.parse(body);
  return {
    ...input,
    financing: input.financing && {
      ...input.financing,
      firstDueDate: input.financing.firstDueDate ? parseDateParam(input.financing.firstDueDate, "firstDueDate") : undefined,
    },
  };
}

/**
 * "Compra de bem" (imóvel, carro): real cost, how it's paid and the impact
 * on the patrimônio (total, líquido, % líquido, reserve, division). Nothing
 * is saved.
 */
insightsRouter.post(
  "/asset-purchase",
  asyncHandler(async (req, res) => {
    res.json(await simulateAssetPurchase(requireUserId(req), parseAssetPurchase(req.body)));
  })
);

/** Registers a simulated purchase: bem at total cost, entrada, financing debt and its installments. */
insightsRouter.post(
  "/asset-purchase/register",
  asyncHandler(async (req, res) => {
    const name = z.string().trim().min(1).max(80).parse(req.body?.name);
    res.status(201).json(await registerAssetPurchase(requireUserId(req), { ...parseAssetPurchase(req.body), name }));
  })
);
