import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireUserId } from "../../core/http/auth-guard.js";
import { parseDateParam } from "../../core/http/date.js";
import * as debtsService from "./debts.service.js";

export const debtsRouter = Router();

const debtTypeSchema = z.enum(["consignado", "emprestimo_pessoal", "cartao_vencido", "outro"]);
const debtStatusSchema = z.enum(["em_dia", "vencida", "negociada", "paga"]);

const debtSchema = z.object({
  creditor: z.string().min(1),
  type: debtTypeSchema,
  status: debtStatusSchema.optional(),
  originalAmount: z.string().optional(),
  currentBalance: z.string(),
  installmentAmount: z.string().optional(),
  installmentDueDay: z.number().int().min(1).max(31).optional(),
  installmentsTotal: z.number().int().min(1).optional(),
  notes: z.string().optional(),
});

const createPaymentSchema = z.object({
  accountId: z.string().uuid(),
  amount: z.string(),
  paymentDate: z.string(),
  notes: z.string().optional(),
});

debtsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const status = debtStatusSchema.optional().parse(req.query.status);
    res.json(await debtsService.listDebts(requireUserId(req), { status }));
  })
);

debtsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = debtSchema.parse(req.body);
    res.status(201).json(await debtsService.createDebt(requireUserId(req), input));
  })
);

debtsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await debtsService.getDebt(requireUserId(req), req.params.id));
  })
);

debtsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const input = debtSchema.partial().parse(req.body);
    res.json(await debtsService.updateDebt(requireUserId(req), req.params.id, input));
  })
);

debtsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await debtsService.deleteDebt(requireUserId(req), req.params.id);
    res.status(204).send();
  })
);

debtsRouter.get(
  "/:id/payments",
  asyncHandler(async (req, res) => {
    res.json(await debtsService.listPayments(requireUserId(req), req.params.id));
  })
);

debtsRouter.post(
  "/:id/payments",
  asyncHandler(async (req, res) => {
    const input = createPaymentSchema.parse(req.body);
    const payment = await debtsService.createPayment(requireUserId(req), req.params.id, {
      ...input,
      paymentDate: parseDateParam(input.paymentDate, "paymentDate"),
    });
    res.status(201).json(payment);
  })
);
