import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireUserId } from "../../core/http/auth-guard.js";
import { parseDateParam } from "../../core/http/date.js";
import * as recurringCardPurchasesService from "./recurring-card-purchases.service.js";

export const recurringCardPurchasesRouter = Router();

const createRecurringCardPurchaseSchema = z
  .object({
    cardId: z.string().uuid(),
    description: z.string().min(1),
    amount: z.string(),
    startDate: z.string(),
    occurrenceCount: z.number().int().min(1).max(120).optional(),
    isOpenEnded: z.boolean().optional(),
    categoryId: z.string().uuid().optional(),
  })
  .refine((input) => input.isOpenEnded || input.occurrenceCount != null, {
    message: "occurrenceCount is required unless isOpenEnded is true",
  });

recurringCardPurchasesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createRecurringCardPurchaseSchema.parse(req.body);
    const recurring = await recurringCardPurchasesService.createRecurringCardPurchase(requireUserId(req), {
      ...input,
      startDate: parseDateParam(input.startDate, "startDate"),
    });
    res.status(201).json(recurring);
  })
);
