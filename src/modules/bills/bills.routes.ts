import { Router } from "express";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireUserId } from "../../core/http/auth-guard.js";
import { AppError } from "../../core/http/errors.js";
import { parseDateParam } from "../../core/http/date.js";
import * as billsService from "./bills.service.js";

export const billsRouter = Router();

billsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { from, to } = req.query;
    if (typeof from !== "string" || typeof to !== "string") {
      throw AppError.badRequest("from and to query params are required (YYYY-MM-DD)");
    }
    const fromDate = parseDateParam(from, "from");
    const toDate = parseDateParam(to, "to");
    if (toDate < fromDate) throw AppError.badRequest("to must be on or after from");
    res.json(await billsService.listBills(requireUserId(req), fromDate, toDate));
  })
);
