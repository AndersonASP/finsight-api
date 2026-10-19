import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireUserId } from "../../core/http/auth-guard.js";
import { parseDateParam } from "../../core/http/date.js";
import * as debtsService from "./debts.service.js";

export const debtsRouter = Router();

const debtTypeSchema = z.enum([
  "consignado",
  "emprestimo_pessoal",
  "financiamento",
  "cartao_vencido",
  "cheque_especial",
  "outro",
]);
const debtStatusSchema = z.enum(["em_dia", "vencida", "negociada", "paga"]);

const debtSchema = z.object({
  creditor: z.string().min(1),
  type: debtTypeSchema,
  status: debtStatusSchema.optional(),
  kind: z.enum(["parcela_fixa", "saldo_variavel"]).optional(),
  originalAmount: z.string().optional(),
  /** Required for saldo_variavel; ignored (kept at 0) for parcela_fixa. */
  currentBalance: z.string().optional(),
  installmentAmount: z.string().optional(),
  installmentDueDay: z.number().int().min(1).max(31).optional(),
  installmentsTotal: z.number().int().min(1).optional(),
  /** "Estou na parcela X" — the installment due this month (parcela_fixa). */
  currentInstallment: z.number().int().min(1).optional(),
  firstInstallmentDate: z.string().optional(),
  payoffAmount: z.string().nullable().optional(),
  monthlyInterestRate: z.string().nullable().optional(),
  /** The bem this debt financed (null unlinks it). */
  assetId: z.string().uuid().nullable().optional(),
  notes: z.string().optional(),
});

function parseDebtDates(input: z.infer<typeof debtSchema>) {
  return {
    ...input,
    firstInstallmentDate: input.firstInstallmentDate
      ? parseDateParam(input.firstInstallmentDate, "firstInstallmentDate")
      : undefined,
  };
}

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
    const input = parseDebtDates(debtSchema.parse(req.body));
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
    const input = parseDebtDates(debtSchema.partial().parse(req.body) as z.infer<typeof debtSchema>);
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
