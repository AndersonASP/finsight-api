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

function signAccessToken(userId: string): { token: string; expiresIn: number } {
  const token = jwt.sign({ sub: userId }, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions["expiresIn"] });
  const decoded = jwt.decode(token) as { exp: number; iat: number };
  return { token, expiresIn: decoded.exp - decoded.iat };
}

function signRefreshToken(userId: string): string {
  return jwt.sign({ sub: userId, type: "refresh" }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_TTL as jwt.SignOptions["expiresIn"],
  });
}

export async function login(email: string, password: string): Promise<TokenPair> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw AppError.unauthorized("Invalid email or password");

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw AppError.unauthorized("Invalid email or password");

  const { token: accessToken, expiresIn } = signAccessToken(user.id);
  const refreshToken = signRefreshToken(user.id);
  return { accessToken, refreshToken, expiresIn };
}

export async function refresh(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }> {
  let payload: { sub: string; type: string };
  try {
    payload = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET) as { sub: string; type: string };
  } catch {
    throw AppError.unauthorized("Invalid or expired refresh token");
  }

  if (payload.type !== "refresh") throw AppError.unauthorized("Invalid refresh token");

  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user) throw AppError.unauthorized("User no longer exists");

  const { token: accessToken, expiresIn } = signAccessToken(user.id);
  return { accessToken, expiresIn };
}
