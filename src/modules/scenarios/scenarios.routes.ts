import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireUserId } from "../../core/http/auth-guard.js";
import { AppError } from "../../core/http/errors.js";
import { parseDateParam } from "../../core/http/date.js";
import { projectScenario } from "../../services/projection-engine.js";
import * as scenariosService from "./scenarios.service.js";

export const scenariosRouter = Router();

scenariosRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await scenariosService.listScenarios(requireUserId(req)));
  })
);

const createScenarioSchema = z.object({ name: z.string().min(1), description: z.string().optional() });

scenariosRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createScenarioSchema.parse(req.body);
    res.status(201).json(await scenariosService.createScenario(requireUserId(req), input));
  })
);

scenariosRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await scenariosService.getScenarioDetail(requireUserId(req), req.params.id));
  })
);

scenariosRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await scenariosService.discardScenario(requireUserId(req), req.params.id);
    res.status(204).send();
  })
);

scenariosRouter.post(
  "/:id/confirm",
  asyncHandler(async (req, res) => {
    await scenariosService.confirmScenario(requireUserId(req), req.params.id);
    res.status(200).json({ status: "confirmed" });
  })
);

const transactionTypeSchema = z.enum(["entrada", "saida", "diario", "economia"]);

const scenarioTransactionSchema = z.object({
  accountId: z.string().uuid(),
  type: transactionTypeSchema,
  amount: z.string(),
  date: z.string(),
  categoryId: z.string().uuid().optional(),
  description: z.string().optional(),
  counterpartAccountId: z.string().uuid().optional(),
});

scenariosRouter.post(
  "/:id/transactions",
  asyncHandler(async (req, res) => {
    const input = scenarioTransactionSchema.parse(req.body);
    const transaction = await scenariosService.addScenarioTransaction(requireUserId(req), req.params.id, {
      ...input,
      date: parseDateParam(input.date, "date"),
    });
    res.status(201).json(transaction);
  })
);

const scenarioPurchaseSchema = z.object({
  cardId: z.string().uuid(),
  purchaseDate: z.string(),
  description: z.string().min(1),
  amount: z.string(),
  categoryId: z.string().uuid().optional(),
  installmentsCount: z.number().int().min(1).optional(),
  knownCharges: z.string().optional(),
});

scenariosRouter.post(
  "/:id/purchases",
  asyncHandler(async (req, res) => {
    const input = scenarioPurchaseSchema.parse(req.body);
    const purchase = await scenariosService.addScenarioPurchase(requireUserId(req), req.params.id, {
      ...input,
      purchaseDate: parseDateParam(input.purchaseDate, "purchaseDate"),
    });
    res.status(201).json(purchase);
  })
);

scenariosRouter.delete(
  "/:id/transactions/:transactionId",
  asyncHandler(async (req, res) => {
    await scenariosService.removeScenarioTransaction(requireUserId(req), req.params.id, req.params.transactionId);
    res.status(204).send();
  })
);

scenariosRouter.delete(
  "/:id/purchases/:purchaseId",
  asyncHandler(async (req, res) => {
    await scenariosService.removeScenarioPurchase(requireUserId(req), req.params.id, req.params.purchaseId);
    res.status(204).send();
  })
);

function parseYearMonth(req: { query: Record<string, unknown> }) {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!year || !month || month < 1 || month > 12) {
    throw AppError.badRequest("year and month query params are required (month 1-12)");
  }
  return { year, month };
}

scenariosRouter.get(
  "/:id/daily-balance",
  asyncHandler(async (req, res) => {
    const { year, month } = parseYearMonth(req);
    res.json(await scenariosService.getScenarioDailyBalance(requireUserId(req), req.params.id, year, month));
  })
);

scenariosRouter.get(
  "/:id/day-detail",
  asyncHandler(async (req, res) => {
    const { date } = req.query;
    if (typeof date !== "string") throw AppError.badRequest("date query param is required (YYYY-MM-DD)");
    res.json(await scenariosService.getScenarioDayDetail(requireUserId(req), req.params.id, parseDateParam(date, "date")));
  })
);

const scenarioBudgetItemSchema = z.object({
  name: z.string().min(1),
  amount: z.string(),
  categoryId: z.string().uuid().optional(),
});

scenariosRouter.post(
  "/:id/budget-items",
  asyncHandler(async (req, res) => {
    const input = scenarioBudgetItemSchema.parse(req.body);
    const item = await scenariosService.addScenarioBudgetItem(requireUserId(req), req.params.id, input);
    res.status(201).json(item);
  })
);

scenariosRouter.get(
  "/:id/projection",
  asyncHandler(async (req, res) => {
    const { from, to } = req.query;
    if (typeof from !== "string" || typeof to !== "string") {
      throw AppError.badRequest("from and to query params are required (YYYY-MM-DD)");
    }
    await scenariosService.getOwnedScenario(requireUserId(req), req.params.id);
    const result = await projectScenario(requireUserId(req), req.params.id, parseDateParam(from, "from"), parseDateParam(to, "to"));
    res.json(result);
  })
);
