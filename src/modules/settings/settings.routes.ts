import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireUserId } from "../../core/http/auth-guard.js";
import * as settingsService from "./settings.service.js";

export const settingsRouter = Router();

const settingsSchema = z.object({
  reserveTargetMonths: z.number().int().min(1).max(36),
});

settingsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await settingsService.getSettings(requireUserId(req)));
  })
);

settingsRouter.patch(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await settingsService.updateSettings(requireUserId(req), settingsSchema.partial().parse(req.body)));
  })
);
