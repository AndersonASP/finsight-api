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

const scenarioInvoicePaymentSchema = z.object({
  accountId: z.string().uuid(),
  paymentDate: z.string(),
  amount: z.string(),
  interestAmount: z.string().optional(),
  realInvoiceId: z.string().uuid().optional(),
  cardId: z.string().uuid().optional(),
  periodYear: z.number().int().optional(),
  periodMonth: z.number().int().min(1).max(12).optional(),
});

scenariosRouter.post(
  "/:id/invoice-payments",
  asyncHandler(async (req, res) => {
    const input = scenarioInvoicePaymentSchema.parse(req.body);
    const payment = await scenariosService.addScenarioInvoicePayment(requireUserId(req), req.params.id, {
      ...input,
      paymentDate: parseDateParam(input.paymentDate, "paymentDate"),
    });
    res.status(201).json(payment);
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
