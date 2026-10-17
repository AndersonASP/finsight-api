import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireUserId } from "../../core/http/auth-guard.js";
import { parseDateParam } from "../../core/http/date.js";
import { AppError } from "../../core/http/errors.js";
import { simulatePurchase } from "./purchase-simulation.service.js";
import { getSavingsCapacity } from "./savings-capacity.service.js";
import { getSummary } from "./summary.service.js";

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
