import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireUserId } from "../../core/http/auth-guard.js";
import { parseDateParam } from "../../core/http/date.js";
import * as wealthService from "./wealth.service.js";

export const wealthRouter = Router();

wealthRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await wealthService.getWealth(requireUserId(req)));
  })
);

wealthRouter.get(
  "/history",
  asyncHandler(async (req, res) => {
    const months = z.coerce.number().int().min(1).max(60).default(12).parse(req.query.months);
    res.json(await wealthService.getWealthHistory(requireUserId(req), months));
  })
);

export const assetsRouter = Router();

const assetSchema = z.object({
  name: z.string().trim().min(1),
  kind: z.enum(["imovel", "veiculo", "a_receber", "outro"]),
  /** Market value, conservative (what it would sell for today). */
  value: z.string().regex(/^\d+(\.\d{1,2})?$/, "value must be a non-negative amount like 1234.56"),
  block: z.enum(["outros", "investimentos"]).optional(),
  /** Defaults to today. */
  valuedAt: z.string().optional(),
  isLiquid: z.boolean().optional(),
  notes: z.string().optional(),
});

assetsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await wealthService.listAssets(requireUserId(req)));
  })
);

assetsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { valuedAt, ...input } = assetSchema.parse(req.body);
    const asset = await wealthService.createAsset(requireUserId(req), {
      ...input,
      valuedAt: parseDateParam(valuedAt ?? new Date().toISOString().slice(0, 10), "valuedAt"),
    });
    res.status(201).json(asset);
  })
);

assetsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const { valuedAt, ...input } = assetSchema.partial().parse(req.body);
    // Changing the value without a date means "worth this today".
    const date = valuedAt ?? (input.value != null ? new Date().toISOString().slice(0, 10) : undefined);
    const asset = await wealthService.updateAsset(requireUserId(req), req.params.id, {
      ...input,
      valuedAt: date ? parseDateParam(date, "valuedAt") : undefined,
    });
    res.json(asset);
  })
);

assetsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await wealthService.deleteAsset(requireUserId(req), req.params.id);
    res.status(204).send();
  })
);
