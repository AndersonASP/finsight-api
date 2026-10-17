import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../core/http/async-handler.js";
import { requireUserId } from "../../core/http/auth-guard.js";
import * as cardsService from "./cards.service.js";

export const cardsRouter = Router();

const cardSchema = z.object({
  name: z.string().min(1),
  brand: z.string().optional(),
  closingDay: z.number().int().min(1).max(31),
  dueDay: z.number().int().min(1).max(31),
  defaultPaymentAccountId: z.string().uuid(),
});

cardsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await cardsService.listCards(requireUserId(req)));
  })
);

cardsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = cardSchema.parse(req.body);
    res.status(201).json(await cardsService.createCard(requireUserId(req), input));
  })
);

cardsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const input = cardSchema.partial().extend({ isArchived: z.boolean().optional() }).parse(req.body);
    res.json(await cardsService.updateCard(requireUserId(req), req.params.id, input));
  })
);

cardsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await cardsService.deleteCard(requireUserId(req), req.params.id);
    res.status(204).send();
  })
);
