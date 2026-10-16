import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireUserId } from "../../core/http/auth-guard.js";
import { parseDateParam } from "../../core/http/date.js";
import * as invoicePaymentsService from "./invoice-payments.service.js";

export const invoicePaymentsRouter = Router({ mergeParams: true });

const createPaymentSchema = z.object({
  accountId: z.string().uuid(),
  paymentDate: z.string(),
  amount: z.string(),
  interestAmount: z.string().optional(),
});

invoicePaymentsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await invoicePaymentsService.listPayments(requireUserId(req), req.params.invoiceId));
  })
);

invoicePaymentsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createPaymentSchema.parse(req.body);
    const payment = await invoicePaymentsService.createPayment(requireUserId(req), req.params.invoiceId, {
      ...input,
      paymentDate: parseDateParam(input.paymentDate, "paymentDate"),
    });
    res.status(201).json(payment);
  })
);
