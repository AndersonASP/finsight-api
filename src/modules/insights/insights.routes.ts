import { Router } from "express";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireUserId } from "../../core/http/auth-guard.js";
import { AppError } from "../../core/http/errors.js";
import { getSavingsCapacity } from "./savings-capacity.service.js";

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
