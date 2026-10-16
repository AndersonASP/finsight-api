import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireUserId } from "../../core/http/auth-guard.js";
import { parseDateParam } from "../../core/http/date.js";
import * as purchasesService from "./purchases.service.js";

export const purchasesRouter = Router();

const createPurchaseSchema = z.object({
  cardId: z.string().uuid(),
  purchaseDate: z.string(),
  description: z.string().min(1),
  amount: z.string(),
  categoryId: z.string().uuid().optional(),
  installmentsCount: z.number().int().min(1).optional(),
  knownCharges: z.string().optional(),
  invoiceOverrideId: z.string().uuid().optional(),
});

purchasesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { cardId, from, to } = req.query;
    const purchases = await purchasesService.listPurchases(requireUserId(req), {
      cardId: typeof cardId === "string" ? cardId : undefined,
      from: typeof from === "string" ? parseDateParam(from, "from") : undefined,
      to: typeof to === "string" ? parseDateParam(to, "to") : undefined,
    });
    res.json(purchases);
  })
);

purchasesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await purchasesService.getPurchase(requireUserId(req), req.params.id));
  })
);

purchasesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createPurchaseSchema.parse(req.body);
    const purchase = await purchasesService.createPurchase(requireUserId(req), {
      ...input,
      purchaseDate: parseDateParam(input.purchaseDate, "purchaseDate"),
    });
    res.status(201).json(purchase);
  })
);

purchasesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await purchasesService.deletePurchase(requireUserId(req), req.params.id);
    res.status(204).send();
  })
);
