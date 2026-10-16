import { Prisma, type AccountType } from "@prisma/client";
import { prisma } from "../../core/db/prisma.js";
import { daysInMonth, addMonthsClamped, startOfUtcDay } from "../../core/http/date.js";
import { AppError } from "../../core/http/errors.js";

export interface AccountInput {
  name: string;
  type: AccountType;
  initialBalance?: string;
}

export async function getOwnedAccount(userId: string, accountId: string) {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account || account.userId !== userId) throw AppError.notFound("Account not found");
  return account;
}

export async function listAccounts(userId: string) {
  return prisma.account.findMany({ where: { userId, isArchived: false }, orderBy: { createdAt: "asc" } });
}

export async function createAccount(userId: string, input: AccountInput) {
  return prisma.account.create({
    data: { userId, name: input.name, type: input.type, initialBalance: input.initialBalance ?? "0" },
  });
}

export async function updateAccount(
  userId: string,
  accountId: string,
  input: Partial<AccountInput> & { isArchived?: boolean }
) {
  await getOwnedAccount(userId, accountId);
  return prisma.account.update({ where: { id: accountId }, data: input });
}

export async function deleteAccount(userId: string, accountId: string) {
  await getOwnedAccount(userId, accountId);
  await prisma.account.delete({ where: { id: accountId } });
}

/**
 * Balance = initial balance, plus `entrada` transactions on this account, minus
 * `saida`/`diario`/`economia` transactions on this account, plus `economia`
 * transfers where this account is the *counterpart* (money arriving via a
 * transfer-to-reserve, see RF-14), minus invoice payments made from this
 * account (RF-12: the card purchases themselves never touch the bank balance —
 * only paying the bill does, on its actual/effective payment date), minus
 * reserve-loan principal lent out from here / plus principal received here,
 * plus reserve-loan repayments received here / minus repayments paid from
 * here (a loan is debt, not an `economia` transfer — see reserve-loans),
 * minus debt payments made from here (paying off a third-party debt, see
 * debts.service.ts, is real money leaving an account).
 * Computed on read rather than cached so it can never drift from the
 * underlying rows. `initialBalance` represents the account's balance at the
 * moment it was registered, not a historical fact — so when `asOfDate` falls
 * before the account's `createdAt`, it's excluded rather than bleeding
 * backward into days before the account existed.
 */
export async function getAccountBalance(userId: string, accountId: string, asOfDate?: Date) {
  const account = await getOwnedAccount(userId, accountId);
  const initialBalanceCounts = !asOfDate || asOfDate.getTime() >= startOfUtcDay(account.createdAt).getTime();
  const dateFilter = asOfDate ? { date: { lte: asOfDate } } : {};
  const paymentDateFilter = asOfDate ? { paymentDate: { lte: asOfDate } } : {};
  const borrowDateFilter = asOfDate ? { borrowDate: { lte: asOfDate } } : {};
  const repaymentDateFilter = asOfDate ? { repaymentDate: { lte: asOfDate } } : {};

  const [
    incoming,
    outgoing,
    transfersIn,
    invoicePayments,
    loansLentFromHere,
    loansReceivedHere,
    repaymentsReceivedHere,
    repaymentsPaidFromHere,
    debtPaymentsFromHere,
  ] = await Promise.all([
    prisma.transaction.aggregate({
      _sum: { amount: true },
      where: { accountId, type: "entrada", ...dateFilter },
    }),
    prisma.transaction.aggregate({
      _sum: { amount: true },
      where: { accountId, type: { in: ["saida", "diario", "economia"] }, ...dateFilter },
    }),
    prisma.transaction.aggregate({
      _sum: { amount: true },
      where: { counterpartAccountId: accountId, type: "economia", ...dateFilter },
    }),
    prisma.invoicePayment.aggregate({
      _sum: { amount: true },
      where: { accountId, ...paymentDateFilter },
    }),
    prisma.reserveLoan.aggregate({
      _sum: { principal: true },
      where: { reserveAccountId: accountId, ...borrowDateFilter },
    }),
    prisma.reserveLoan.aggregate({
      _sum: { principal: true },
      where: { destinationAccountId: accountId, ...borrowDateFilter },
    }),
    prisma.reserveLoanRepayment.aggregate({
      _sum: { amount: true },
      where: { loan: { reserveAccountId: accountId }, ...repaymentDateFilter },
    }),
    prisma.reserveLoanRepayment.aggregate({
      _sum: { amount: true },
      where: { loan: { destinationAccountId: accountId }, ...repaymentDateFilter },
    }),
    prisma.debtPayment.aggregate({
      _sum: { amount: true },
      where: { accountId, ...paymentDateFilter },
    }),
  ]);

  return (initialBalanceCounts ? new Prisma.Decimal(account.initialBalance) : new Prisma.Decimal(0))
    .plus(incoming._sum.amount ?? 0)
    .minus(outgoing._sum.amount ?? 0)
    .plus(transfersIn._sum.amount ?? 0)
    .minus(invoicePayments._sum.amount ?? 0)
    .minus(loansLentFromHere._sum.principal ?? 0)
    .plus(loansReceivedHere._sum.principal ?? 0)
    .plus(repaymentsReceivedHere._sum.amount ?? 0)
    .minus(repaymentsPaidFromHere._sum.amount ?? 0)
    .minus(debtPaymentsFromHere._sum.amount ?? 0);
}

export async function createBalanceSnapshot(
  userId: string,
  accountId: string,
  input: { snapshotDate: Date; balance: string; note?: string }
) {
  await getOwnedAccount(userId, accountId);
  return prisma.accountBalanceSnapshot.upsert({
    where: { accountId_snapshotDate: { accountId, snapshotDate: input.snapshotDate } },
    update: { balance: input.balance, note: input.note },
    create: { accountId, snapshotDate: input.snapshotDate, balance: input.balance, note: input.note },
  });
}

export async function listBalanceSnapshots(userId: string, accountId: string) {
  await getOwnedAccount(userId, accountId);
  return prisma.accountBalanceSnapshot.findMany({ where: { accountId }, orderBy: { snapshotDate: "asc" } });
}

export interface AccountBalanceHistoryPoint {
  year: number;
  month: number;
  balance: string;
}

/**
 * End-of-month balance for the last `months` months (including the current,
 * partial one, measured as of today). For a report screen's "evolução do
 * saldo" chart — reuses getAccountBalance at each month-end rather than
 * caching anything, same "never drift from the underlying rows" principle.
 */
export async function getAccountBalanceHistory(
  userId: string,
  accountId: string,
  months: number
): Promise<AccountBalanceHistoryPoint[]> {
  await getOwnedAccount(userId, accountId);
  const today = new Date();
  const thisMonthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));

  const points: AccountBalanceHistoryPoint[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const monthStart = addMonthsClamped(thisMonthStart, -i);
    const year = monthStart.getUTCFullYear();
    const month = monthStart.getUTCMonth() + 1;
    const asOfDate =
      i === 0 ? today : new Date(Date.UTC(year, month - 1, daysInMonth(year, month)));
    const balance = await getAccountBalance(userId, accountId, asOfDate);
    points.push({ year, month, balance: balance.toFixed(2) });
  }
  return points;
}
