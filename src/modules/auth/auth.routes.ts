import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { env } from "../../core/config/env.js";
import { asyncHandler } from "../../core/http/async-handler.js";
import { authGuard, requireUserId } from "../../core/http/auth-guard.js";
import * as authService from "./auth.service.js";

export const authRouter = Router();

// Brute-force protection: failed logins per IP are capped; successful ones
// don't count, so normal use never hits the limit.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.NODE_ENV === "test" ? 1000 : 10,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: { code: "too_many_requests", message: "Too many login attempts, try again later" } },
});

const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.NODE_ENV === "test" ? 1000 : 100,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: { code: "too_many_requests", message: "Too many requests, try again later" } },
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post(
  "/login",
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const tokens = await authService.login(email, password);
    res.json(tokens);
  })
);

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

authRouter.post(
  "/refresh",
  refreshLimiter,
  asyncHandler(async (req, res) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    const tokens = await authService.refresh(refreshToken);
    res.json(tokens);
  })
);

authRouter.post(
  "/logout",
  refreshLimiter,
  asyncHandler(async (req, res) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    await authService.logout(refreshToken);
    res.status(204).send();
  })
);

authRouter.post(
  "/logout-all",
  authGuard,
  asyncHandler(async (req, res) => {
    await authService.logoutAll(requireUserId(req));
    res.status(204).send();
  })
);
