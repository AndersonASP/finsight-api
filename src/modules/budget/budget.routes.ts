import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireUserId } from "../../core/http/auth-guard.js";
import { AppError } from "../../core/http/errors.js";
import { parseDateParam } from "../../core/http/date.js";
import * as budgetService from "./budget.service.js";

export const budgetRouter = Router();

const budgetItemSchema = z.object({
  name: z.string().min(1),
  amount: z.string(),
  categoryId: z.string().uuid().optional(),
  active: z.boolean().optional(),
  startsOn: z.string().optional(),
  endsOn: z.string().optional(),
});

function toServiceInput(input: z.infer<typeof budgetItemSchema>) {
  return {
    ...input,
    startsOn: input.startsOn ? parseDateParam(input.startsOn, "startsOn") : undefined,
    endsOn: input.endsOn ? parseDateParam(input.endsOn, "endsOn") : undefined,
  };
}

budgetRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await budgetService.listBudgetItems(requireUserId(req)));
  })
);

budgetRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = budgetItemSchema.parse(req.body);
    res.status(201).json(await budgetService.createBudgetItem(requireUserId(req), toServiceInput(input)));
  })
);

budgetRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const input = budgetItemSchema.partial().parse(req.body);
    res.json(await budgetService.updateBudgetItem(requireUserId(req), req.params.id, toServiceInput(input as z.infer<typeof budgetItemSchema>)));
  })
);

budgetRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await budgetService.deleteBudgetItem(requireUserId(req), req.params.id);
    res.status(204).send();
  })
);

budgetRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const year = Number(req.query.year);
    const month = Number(req.query.month);
    if (!year || !month) throw AppError.badRequest("year and month query params are required");

    res.json(await budgetService.getBudgetSummary(requireUserId(req), year, month));
  })
);
