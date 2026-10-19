import { prisma } from "../../core/db/prisma.js";
import { AppError } from "../../core/http/errors.js";

export interface Settings {
  reserveTargetMonths: number;
}

export async function getSettings(userId: string): Promise<Settings> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { reserveTargetMonths: true } });
  if (!user) throw AppError.notFound("User not found");
  return user;
}

export async function updateSettings(userId: string, input: Partial<Settings>): Promise<Settings> {
  return prisma.user.update({ where: { id: userId }, data: input, select: { reserveTargetMonths: true } });
}

/** Months of cost of living the user wants in the emergency reserve. */
export async function getReserveTargetMonths(userId: string) {
  return (await getSettings(userId)).reserveTargetMonths;
}
