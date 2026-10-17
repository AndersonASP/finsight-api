import type { NextFunction, Request, Response } from "express";
import { prisma } from "../db/prisma.js";
import { requireUserId } from "./auth-guard.js";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * After an authenticated request that changed something succeeds, bumps the
 * user's `dataVersion`. Clients (the app, the widget sync) poll
 * GET /sync/version and refetch only when it moved — so a change made
 * anywhere (another device, the MCP server, an Apple Pay automation) shows
 * up without reopening the app. Bumped on `finish`, i.e. after the write
 * committed, so a client never sees the new version before the new data.
 */
export function trackDataChanges(req: Request, res: Response, next: NextFunction) {
  if (!READ_METHODS.has(req.method)) {
    res.on("finish", () => {
      if (res.statusCode >= 400) return;
      const userId = requireUserId(req);
      if (!userId) return;
      prisma.user
        .update({ where: { id: userId }, data: { dataVersion: { increment: 1 } } })
        .catch(() => {}); // user deleted meanwhile — nothing to signal
    });
  }
  next();
}

export async function getDataVersion(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { dataVersion: true } });
  return { version: user?.dataVersion ?? 0 };
}
