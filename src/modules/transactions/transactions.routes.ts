import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireUserId } from "../../core/http/auth-guard.js";
import { parseDateParam } from "../../core/http/date.js";
import * as transactionsService from "./transactions.service.js";

export const transactionsRouter = Router();

const transactionTypeSchema = z.enum(["entrada", "saida", "diario", "economia"]);

const createTransactionSchema = z.object({
  accountId: z.string().uuid(),
  type: transactionTypeSchema,
  amount: z.string(),
  date: z.string(),
  categoryId: z.string().uuid().optional(),
  description: z.string().optional(),
  counterpartAccountId: z.string().uuid().optional(),
});

transactionsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { from, to, type, categoryId, accountId } = req.query;
    const transactions = await transactionsService.listTransactions(requireUserId(req), {
      from: typeof from === "string" ? parseDateParam(from, "from") : undefined,
      to: typeof to === "string" ? parseDateParam(to, "to") : undefined,
      type: typeof type === "string" ? transactionTypeSchema.parse(type) : undefined,
      categoryId: typeof categoryId === "string" ? categoryId : undefined,
      accountId: typeof accountId === "string" ? accountId : undefined,
    });
    res.json(transactions);
  })
);

transactionsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createTransactionSchema.parse(req.body);
    const transaction = await transactionsService.createTransaction(requireUserId(req), {
      ...input,
      date: parseDateParam(input.date, "date"),
    });
    res.status(201).json(transaction);
  })
);

transactionsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await transactionsService.getTransaction(requireUserId(req), req.params.id));
  })
);

transactionsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const input = createTransactionSchema.partial().parse(req.body);
    const transaction = await transactionsService.updateTransaction(requireUserId(req), req.params.id, {
      ...input,
      date: input.date ? parseDateParam(input.date, "date") : undefined,
    });
    res.json(transaction);
  })
);

const deleteScopeSchema = z.enum(["this", "future"]).optional();

transactionsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const scope = deleteScopeSchema.parse(req.query.scope);
    await transactionsService.deleteTransaction(requireUserId(req), req.params.id, scope);
    res.status(204).send();
  })
);
