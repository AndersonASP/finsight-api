import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireUserId } from "../../core/http/auth-guard.js";
import { parseDateParam } from "../../core/http/date.js";
import * as reserveLoansService from "./reserve-loans.service.js";

export const reserveLoansRouter = Router();

const createLoanSchema = z.object({
  reserveAccountId: z.string().uuid(),
  destinationAccountId: z.string().uuid(),
  principal: z.string(),
  borrowDate: z.string(),
  description: z.string().optional(),
});

const createRepaymentSchema = z.object({
  repaymentDate: z.string(),
  amount: z.string(),
});

reserveLoansRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const accountId = typeof req.query.accountId === "string" ? req.query.accountId : undefined;
    const status = z.enum(["active", "settled"]).optional().parse(req.query.status);
    res.json(await reserveLoansService.listLoans(requireUserId(req), { accountId, status }));
  })
);

reserveLoansRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createLoanSchema.parse(req.body);
    const loan = await reserveLoansService.createLoan(requireUserId(req), {
      ...input,
      borrowDate: parseDateParam(input.borrowDate, "borrowDate"),
    });
    res.status(201).json(loan);
  })
);

reserveLoansRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await reserveLoansService.getLoan(requireUserId(req), req.params.id));
  })
);

reserveLoansRouter.get(
  "/:id/owed",
  asyncHandler(async (req, res) => {
    res.json(await reserveLoansService.getOwed(requireUserId(req), req.params.id));
  })
);

reserveLoansRouter.get(
  "/:id/repayments",
  asyncHandler(async (req, res) => {
    res.json(await reserveLoansService.listRepayments(requireUserId(req), req.params.id));
  })
);

reserveLoansRouter.post(
  "/:id/repayments",
  asyncHandler(async (req, res) => {
    const input = createRepaymentSchema.parse(req.body);
    const repayment = await reserveLoansService.createRepayment(requireUserId(req), req.params.id, {
      amount: input.amount,
      repaymentDate: parseDateParam(input.repaymentDate, "repaymentDate"),
    });
    res.status(201).json(repayment);
  })
);
