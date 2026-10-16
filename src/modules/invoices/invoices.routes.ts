import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireUserId } from "../../core/http/auth-guard.js";
import * as invoicesService from "./invoices.service.js";

export const invoicesRouter = Router();

const invoiceStatusSchema = z.enum(["open", "closed", "paid", "partially_paid"]);

invoicesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { cardId, status } = req.query;
    const invoices = await invoicesService.listInvoices(requireUserId(req), {
      cardId: typeof cardId === "string" ? cardId : undefined,
      status: typeof status === "string" ? invoiceStatusSchema.parse(status) : undefined,
    });
    res.json(invoices);
  })
);

invoicesRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await invoicesService.getInvoiceDetail(requireUserId(req), req.params.id));
  })
);

const reassignSchema = z.object({ invoiceId: z.string().uuid() });

export const installmentsRouter = Router();

installmentsRouter.patch(
  "/:id/invoice",
  asyncHandler(async (req, res) => {
    const { invoiceId } = reassignSchema.parse(req.body);
    const installment = await invoicesService.reassignInstallmentInvoice(requireUserId(req), req.params.id, invoiceId);
    res.json(installment);
  })
);
