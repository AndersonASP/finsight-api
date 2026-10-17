import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../../core/config/env.js";
import { prisma } from "../../core/db/prisma.js";
import { AppError } from "../../core/http/errors.js";

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface RefreshPayload {
  sub: string;
  type: string;
  jti?: string;
}

function signAccessToken(userId: string): { token: string; expiresIn: number } {
  const token = jwt.sign({ sub: userId }, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions["expiresIn"] });
  const decoded = jwt.decode(token) as { exp: number; iat: number };
  return { token, expiresIn: decoded.exp - decoded.iat };
}

/**
 * Signs a refresh token whose `jti` is a `refresh_tokens` row, so it stays
 * valid only while that row exists and isn't revoked.
 */
async function issueRefreshToken(userId: string): Promise<string> {
  const jti = randomUUID();
  const token = jwt.sign({ sub: userId, type: "refresh" }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_TTL as jwt.SignOptions["expiresIn"],
    jwtid: jti,
  });
  const { exp } = jwt.decode(token) as { exp: number };
  await prisma.refreshToken.create({
    data: { id: jti, userId, expiresAt: new Date(exp * 1000) },
  });
  return token;
}

function verifyRefreshToken(refreshToken: string): RefreshPayload {
  let payload: RefreshPayload;
  try {
    payload = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET) as RefreshPayload;
  } catch {
    throw AppError.unauthorized("Invalid or expired refresh token");
  }
  if (payload.type !== "refresh") throw AppError.unauthorized("Invalid refresh token");
  return payload;
}

export async function login(email: string, password: string): Promise<TokenPair> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw AppError.unauthorized("Invalid email or password");

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw AppError.unauthorized("Invalid email or password");

  // Opportunistic cleanup so the table doesn't grow with long-dead sessions.
  await prisma.refreshToken.deleteMany({ where: { userId: user.id, expiresAt: { lt: new Date() } } });

  const { token: accessToken, expiresIn } = signAccessToken(user.id);
  const refreshToken = await issueRefreshToken(user.id);
  return { accessToken, refreshToken, expiresIn };
}

export async function refresh(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  const payload = verifyRefreshToken(refreshToken);

  // Tokens issued before server-side tracking have no jti and are rejected,
  // forcing one fresh login.
  const stored = payload.jti ? await prisma.refreshToken.findUnique({ where: { id: payload.jti } }) : null;
  if (!stored || stored.revokedAt || stored.userId !== payload.sub) {
    throw AppError.unauthorized("Refresh token has been revoked");
  }

  await prisma.refreshToken.update({ where: { id: stored.id }, data: { lastUsedAt: new Date() } });

  const { token: accessToken, expiresIn } = signAccessToken(stored.userId);
  return { accessToken, expiresIn };
}

/** Revokes the session behind `refreshToken`. Idempotent: an invalid or already-revoked token is a no-op. */
export async function logout(refreshToken: string): Promise<void> {
  let payload: RefreshPayload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    return;
  }
  if (!payload.jti) return;
  await prisma.refreshToken.updateMany({
    where: { id: payload.jti, userId: payload.sub, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Revokes every active session of the user (e.g. a lost phone). Already-issued access tokens still live until they expire (15m). */
export async function logoutAll(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
