import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireUserId } from "../../core/http/auth-guard.js";
import * as wishlistService from "./wishlist.service.js";

export const wishlistRouter = Router();

const wishlistItemSchema = z.object({
  description: z.string().trim().min(1).max(80),
  amount: z.string().refine((v) => Number(v) > 0, "amount must be positive"),
  pixDiscountPercent: z.number().min(0).max(50).nullable().optional(),
  interestFreeInstallments: z.number().int().min(1).max(24).optional(),
});

/** "Quero comprar": each item comes back with today's "E se?" simulation. */
wishlistRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await wishlistService.listWishlist(requireUserId(req)));
  })
);

wishlistRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = wishlistItemSchema.parse(req.body);
    res.status(201).json(await wishlistService.createWishlistItem(requireUserId(req), input));
  })
);

wishlistRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const input = wishlistItemSchema.partial().parse(req.body);
    res.json(await wishlistService.updateWishlistItem(requireUserId(req), req.params.id, input));
  })
);

wishlistRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await wishlistService.deleteWishlistItem(requireUserId(req), req.params.id);
    res.status(204).send();
  })
);
