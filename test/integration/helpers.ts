import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../../src/core/config/env.js";
import { prisma } from "../../src/core/db/prisma.js";

export async function createTestUser() {
  const email = `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const passwordHash = await bcrypt.hash("password123", 4);
  const user = await prisma.user.create({ data: { email, passwordHash } });
  const token = jwt.sign({ sub: user.id }, env.JWT_ACCESS_SECRET, { expiresIn: "15m" });
  return { user, token };
}

/**
 * Today as YYYY-MM-DD (UTC). Fixtures that create an account and then query
 * its balance "as of" a date within the same test must anchor to this
 * instead of a hardcoded calendar string — an account's `initialBalance`
 * only counts from its real `createdAt` forward (see accounts.service.ts's
 * getAccountBalance), so a fixed-but-past date eventually goes stale and
 * starts failing once real time catches up to it.
 */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** `n` months after a YYYY-MM-DD string, clamping day-of-month like the app's own addMonthsClamped. */
export function addMonthsIso(isoDate: string, n: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const targetMonthIndex = month - 1 + n;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, daysInTargetMonth);
  return `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}

/**
 * A {year, month} pair `monthsAhead` months from now — use for daily-balance/
 * monthly-totals fixtures so the queried month's start is always safely
 * after any account created within the same test (same staleness reason as
 * `todayIso` above).
 */
export function futureYearMonth(monthsAhead: number): { year: number; month: number } {
  const now = new Date();
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsAhead, 1));
  return { year: base.getUTCFullYear(), month: base.getUTCMonth() + 1 };
}

export async function cleanupDatabase() {
  await prisma.wishlistItem.deleteMany();
  await prisma.scenarioBudgetItem.deleteMany();
  await prisma.scenarioInstallment.deleteMany();
  await prisma.scenarioPurchase.deleteMany();
  await prisma.scenarioTransaction.deleteMany();
  await prisma.scenario.deleteMany();
  await prisma.reserveLoanRepayment.deleteMany();
  await prisma.reserveLoan.deleteMany();
  // Cascades to delete every Transaction row generated for the series too.
  await prisma.recurringTransaction.deleteMany();
  await prisma.debtPayment.deleteMany();
  await prisma.debt.deleteMany();
  await prisma.installment.deleteMany();
  await prisma.invoice.deleteMany();
  // Cascades to delete every Purchase row generated for the series too.
  await prisma.recurringCardPurchase.deleteMany();
  await prisma.purchase.deleteMany();
  await prisma.card.deleteMany();
  await prisma.budgetItem.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.accountBalanceSnapshot.deleteMany();
  await prisma.account.deleteMany();
  await prisma.category.deleteMany();
  await prisma.savingsGoal.deleteMany();
  await prisma.netWorthSnapshot.deleteMany();
  await prisma.assetValuation.deleteMany();
  await prisma.asset.deleteMany();
  await prisma.walletCardMapping.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();
}
