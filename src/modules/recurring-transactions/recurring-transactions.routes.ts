import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireUserId } from "../../core/http/auth-guard.js";
import { parseDateParam } from "../../core/http/date.js";
import * as recurringTransactionsService from "./recurring-transactions.service.js";

export const recurringTransactionsRouter = Router();

const createRecurringTransactionSchema = z
  .object({
    accountId: z.string().uuid(),
    type: z.enum(["entrada", "saida", "diario", "economia"]),
    amount: z.string(),
    startDate: z.string(),
    interval: z.enum(["daily", "weekly", "biweekly", "monthly", "annual"]),
    occurrenceCount: z.number().int().min(1).max(3650).optional(),
    isOpenEnded: z.boolean().optional(),
    categoryId: z.string().uuid().optional(),
    description: z.string().optional(),
    counterpartAccountId: z.string().uuid().optional(),
  })
  .refine((input) => input.isOpenEnded || input.occurrenceCount != null, {
    message: "occurrenceCount is required unless isOpenEnded is true",
  });

recurringTransactionsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createRecurringTransactionSchema.parse(req.body);
    const recurring = await recurringTransactionsService.createRecurringTransaction(requireUserId(req), {
      ...input,
      startDate: parseDateParam(input.startDate, "startDate"),
    });
    res.status(201).json(recurring);
  })
);
