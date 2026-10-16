import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireUserId } from "../../core/http/auth-guard.js";
import * as savingsGoalsService from "./savings-goals.service.js";

export const savingsGoalsRouter = Router();

const savingsGoalSchema = z.object({
  periodType: z.enum(["monthly", "annual"]),
  periodYear: z.number().int(),
  periodMonth: z.number().int().min(1).max(12).optional(),
  targetPercent: z.string(),
  methodologyNote: z.string().optional(),
});

savingsGoalsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await savingsGoalsService.listSavingsGoals(requireUserId(req)));
  })
);

savingsGoalsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = savingsGoalSchema.parse(req.body);
    res.status(201).json(await savingsGoalsService.createSavingsGoal(requireUserId(req), input));
  })
);

savingsGoalsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const input = savingsGoalSchema.partial().parse(req.body);
    res.json(await savingsGoalsService.updateSavingsGoal(requireUserId(req), req.params.id, input));
  })
);

savingsGoalsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await savingsGoalsService.deleteSavingsGoal(requireUserId(req), req.params.id);
    res.status(204).send();
  })
);

savingsGoalsRouter.get(
  "/:id/progress",
  asyncHandler(async (req, res) => {
    res.json(await savingsGoalsService.getProgress(requireUserId(req), req.params.id));
  })
);
