import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireUserId } from "../../core/http/auth-guard.js";
import { parseDateParam } from "../../core/http/date.js";
import * as quickEntriesService from "./quick-entries.service.js";

export const quickEntriesRouter = Router();

/**
 * Shortcuts hands the amount over as a number or as text, possibly in pt-BR
 * ("1.234,56", "R$ 26,00") — normalize to a plain "1234.56" decimal string.
 */
const amountSchema = z.union([z.number(), z.string()]).transform((value, ctx) => {
  let text = String(value).replace(/[^\d.,-]/g, "");
  if (text.includes(",")) text = text.replace(/\./g, "").replace(",", ".");
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount <= 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "amount must be a positive number" });
    return z.NEVER;
  }
  return amount.toFixed(2);
});

const quickEntrySchema = z.object({
  amount: amountSchema,
  merchant: z.string().trim().min(1),
  cardName: z.string().optional(),
  /** The device's local date (YYYY-MM-DD) — defaults to today in UTC. */
  date: z.string().optional(),
});

quickEntriesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = quickEntrySchema.parse(req.body);
    const date = input.date ? parseDateParam(input.date) : parseDateParam(new Date().toISOString().slice(0, 10));
    const result = await quickEntriesService.createQuickEntry(requireUserId(req), { ...input, date });
    res.status(201).json(result);
  })
);

quickEntriesRouter.get(
  "/mappings",
  asyncHandler(async (req, res) => {
    res.json(await quickEntriesService.listMappings(requireUserId(req)));
  })
);

const mappingSchema = z.object({
  walletName: z.string().min(1),
  cardId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
});

quickEntriesRouter.put(
  "/mappings",
  asyncHandler(async (req, res) => {
    const input = mappingSchema.parse(req.body);
    res.json(await quickEntriesService.upsertMapping(requireUserId(req), input));
  })
);

quickEntriesRouter.delete(
  "/mappings/:id",
  asyncHandler(async (req, res) => {
    await quickEntriesService.deleteMapping(requireUserId(req), req.params.id);
    res.status(204).send();
  })
);
