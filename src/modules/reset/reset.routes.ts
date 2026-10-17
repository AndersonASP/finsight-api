import { Router } from "express";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireUserId } from "../../core/http/auth-guard.js";
import * as resetService from "./reset.service.js";

export const resetRouter = Router();

resetRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await resetService.resetUserData(requireUserId(req)));
  })
);
