import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireUserId } from "../../core/http/auth-guard.js";
import { AppError } from "../../core/http/errors.js";
import * as categoriesService from "./categories.service.js";

export const categoriesRouter = Router();

const categorySchema = z.object({
  name: z.string().min(1),
  color: z.string().min(1),
  icon: z.string().optional(),
});

categoriesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await categoriesService.listCategories(requireUserId(req)));
  })
);

categoriesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = categorySchema.parse(req.body);
    res.status(201).json(await categoriesService.createCategory(requireUserId(req), input));
  })
);

categoriesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const input = categorySchema.partial().parse(req.body);
    res.json(await categoriesService.updateCategory(requireUserId(req), req.params.id, input));
  })
);

categoriesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await categoriesService.deleteCategory(requireUserId(req), req.params.id);
    res.status(204).send();
  })
);

categoriesRouter.get(
  "/:id/totals",
  asyncHandler(async (req, res) => {
    const year = Number(req.query.year);
    const month = Number(req.query.month);
    if (!year || !month) throw AppError.badRequest("year and month query params are required");

    const total = await categoriesService.getCategoryTotal(requireUserId(req), req.params.id, year, month);
    res.json({ total: total.toString() });
  })
);
