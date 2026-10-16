import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireUserId } from "../../core/http/auth-guard.js";
import { parseDateParam } from "../../core/http/date.js";
import * as accountsService from "./accounts.service.js";

export const accountsRouter = Router();

const accountTypeSchema = z.enum(["checking", "cash", "savings_reserve", "investment"]);

const createAccountSchema = z.object({
  name: z.string().min(1),
  type: accountTypeSchema,
  initialBalance: z.string().optional(),
});

const updateAccountSchema = createAccountSchema.partial().extend({
  isArchived: z.boolean().optional(),
});

accountsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const accounts = await accountsService.listAccounts(requireUserId(req));
    res.json(accounts);
  })
);

accountsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createAccountSchema.parse(req.body);
    const account = await accountsService.createAccount(requireUserId(req), input);
    res.status(201).json(account);
  })
);

accountsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const input = updateAccountSchema.parse(req.body);
    const account = await accountsService.updateAccount(requireUserId(req), req.params.id, input);
    res.json(account);
  })
);

accountsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await accountsService.deleteAccount(requireUserId(req), req.params.id);
    res.status(204).send();
  })
);

accountsRouter.get(
  "/:id/balance",
  asyncHandler(async (req, res) => {
    const asOfDate = typeof req.query.date === "string" ? parseDateParam(req.query.date, "date") : undefined;
    const balance = await accountsService.getAccountBalance(requireUserId(req), req.params.id, asOfDate);
    res.json({ balance: balance.toFixed(2) });
  })
);

const monthsQuerySchema = z.coerce.number().int().min(1).max(60).default(12);

accountsRouter.get(
  "/:id/balance-history",
  asyncHandler(async (req, res) => {
    const months = monthsQuerySchema.parse(req.query.months);
    const history = await accountsService.getAccountBalanceHistory(requireUserId(req), req.params.id, months);
    res.json(history);
  })
);

const createSnapshotSchema = z.object({
  snapshotDate: z.string(),
  balance: z.string(),
  note: z.string().optional(),
});

accountsRouter.get(
  "/:id/balance-snapshots",
  asyncHandler(async (req, res) => {
    const snapshots = await accountsService.listBalanceSnapshots(requireUserId(req), req.params.id);
    res.json(snapshots);
  })
);

accountsRouter.post(
  "/:id/balance-snapshots",
  asyncHandler(async (req, res) => {
    const input = createSnapshotSchema.parse(req.body);
    const snapshot = await accountsService.createBalanceSnapshot(requireUserId(req), req.params.id, {
      snapshotDate: parseDateParam(input.snapshotDate, "snapshotDate"),
      balance: input.balance,
      note: input.note,
    });
    res.status(201).json(snapshot);
  })
);
