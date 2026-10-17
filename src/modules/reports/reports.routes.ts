import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireUserId } from "../../core/http/auth-guard.js";
import { AppError } from "../../core/http/errors.js";
import { parseDateParam } from "../../core/http/date.js";
import * as reportsService from "./reports.service.js";

export const reportsRouter = Router();

function parseYearMonth(req: { query: Record<string, unknown> }) {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!year || !month || month < 1 || month > 12) {
    throw AppError.badRequest("year and month query params are required (month 1-12)");
  }
  return { year, month };
}

reportsRouter.get(
  "/daily-balance",
  asyncHandler(async (req, res) => {
    const { year, month } = parseYearMonth(req);
    const accountId = typeof req.query.accountId === "string" ? req.query.accountId : undefined;
    res.json(await reportsService.getDailyBalance(requireUserId(req), year, month, accountId));
  })
);

reportsRouter.get(
  "/monthly-totals",
  asyncHandler(async (req, res) => {
    const { year, month } = parseYearMonth(req);
    res.json(await reportsService.getMonthlyTotals(requireUserId(req), year, month));
  })
);

reportsRouter.get(
  "/day-detail",
  asyncHandler(async (req, res) => {
    // `from`+`to` (inclusive) returns every day in the range at once — the
    // app uses it to cache a whole month's line items for offline use.
    const { date, from, to } = req.query;
    if (typeof from === "string" && typeof to === "string") {
      const fromDate = parseDateParam(from, "from");
      const toDate = parseDateParam(to, "to");
      if (toDate.getTime() < fromDate.getTime()) throw AppError.badRequest("to must not be before from");
      if (toDate.getTime() - fromDate.getTime() > 62 * 24 * 60 * 60 * 1000) {
        throw AppError.badRequest("from/to range must be at most 62 days");
      }
      res.json(await reportsService.getDayDetail(requireUserId(req), fromDate, toDate));
      return;
    }
    if (typeof date !== "string") throw AppError.badRequest("date query param is required (YYYY-MM-DD)");
    res.json(await reportsService.getDayDetail(requireUserId(req), parseDateParam(date, "date")));
  })
);

reportsRouter.get(
  "/category-breakdown",
  asyncHandler(async (req, res) => {
    const { year, month } = parseYearMonth(req);
    res.json(await reportsService.getCategoryBreakdown(requireUserId(req), year, month));
  })
);

reportsRouter.get(
  "/card-spending",
  asyncHandler(async (req, res) => {
    const year = Number(req.query.year);
    if (!year) throw AppError.badRequest("year query param is required");
    const month = req.query.month != null ? Number(req.query.month) : undefined;
    if (month != null && (month < 1 || month > 12)) {
      throw AppError.badRequest("month query param must be 1-12");
    }
    res.json(await reportsService.getCardSpending(requireUserId(req), year, month));
  })
);

const monthsQuerySchema = z.coerce.number().int().min(1).max(60).default(6);

reportsRouter.get(
  "/monthly-trend",
  asyncHandler(async (req, res) => {
    const months = monthsQuerySchema.parse(req.query.months);
    res.json(await reportsService.getMonthlyTrend(requireUserId(req), months));
  })
);

reportsRouter.get(
  "/budget-vs-actual",
  asyncHandler(async (req, res) => {
    const { year, month } = parseYearMonth(req);
    res.json(await reportsService.getBudgetVsActual(requireUserId(req), year, month));
  })
);
