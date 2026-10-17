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

/**
 * Transactions/recurring-series/snapshots *owned* by this account cascade on
 * delete (so they're fine to let go — the Flutter side warns about that loss
 * of history first). Everything else below only *references* this account
 * without owning it, so the DB has no cascade rule for it — deleting the
 * account would otherwise fail with a raw foreign-key error (or, worse,
 * silently orphan a card/loan's "which account" pointer). Block instead,
 * with a reason the user can actually act on.
 */
export async function deleteAccount(userId: string, accountId: string) {
  const account = await getOwnedAccount(userId, accountId);

  const [cardsUsingIt, reserveLoansUsingIt, debtPaymentsUsingIt, counterpartTransactions, counterpartRecurring, otherCheckingAccounts] =
    await Promise.all([
      prisma.card.count({ where: { defaultPaymentAccountId: accountId } }),
      prisma.reserveLoan.count({ where: { OR: [{ reserveAccountId: accountId }, { destinationAccountId: accountId }] } }),
      prisma.debtPayment.count({ where: { accountId } }),
      prisma.transaction.count({ where: { counterpartAccountId: accountId } }),
      prisma.recurringTransaction.count({ where: { counterpartAccountId: accountId } }),
      account.type === "checking"
        ? prisma.account.count({ where: { userId, type: "checking", isArchived: false, id: { not: accountId } } })
        : Promise.resolve(1), // not a checking account: this guard doesn't apply
    ]);

  const reasons: string[] = [];
  if (cardsUsingIt > 0) reasons.push("é a conta de pagamento padrão de um ou mais cartões");
  if (reserveLoansUsingIt > 0) reasons.push("tem empréstimo(s) da reserva vinculado(s)");
  if (debtPaymentsUsingIt > 0) reasons.push("tem pagamento(s) de dívida registrados");
  if (counterpartTransactions > 0 || counterpartRecurring > 0) {
    reasons.push("é destino de alguma transferência (economia) de outra conta");
  }
  // Every "adicionar lançamento" flow assumes at least one checking account
  // exists for its smart default — removing the last one would dead-end it.
  if (otherCheckingAccounts === 0) {
    reasons.push("é a única conta corrente cadastrada — crie outra antes de remover esta");
  }

  if (reasons.length > 0) {
    throw AppError.badRequest(`Não é possível excluir esta conta: ela ${reasons.join(" e ")}.`);
  }

  await prisma.account.delete({ where: { id: accountId } });
}

/**
 * Balance = initial balance, plus `entrada` transactions on this account, minus
 * `saida`/`diario`/`economia` transactions on this account, plus `economia`
 * transfers where this account is the *counterpart* (money arriving via a
 * transfer-to-reserve, see RF-14), minus every card installment whose
 * *due date* has passed and whose card's default payment account is this one
 * (RF-12: the purchase itself never touches the bank balance — the bill
 * debits automatically, in full, on the due date; there's no separate manual
 * payment step), minus reserve-loan principal lent out from here / plus principal received here,
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
  // Every one of these is bounded, even when the caller passes no asOfDate
  // at all ("balance right now"): a recurring lançamento ("a perder de
  // vista") or a parcelado/assinatura purchase eagerly generates every
  // future occurrence/installment up front (see
  // recurring-transactions.service.ts, purchases.service.ts,
  // recurring-card-purchase-generator.service.ts) — an unbounded sum here
  // would pull years of not-yet-happened activity into "right now"'s
  // balance. "No asOfDate" always means "as of today", never "forever".
  const effectiveAsOfDate = asOfDate ?? startOfUtcDay(new Date());
  const dateFilter = { date: { lte: effectiveAsOfDate } };
  const dueDateFilter = { dueDate: { lte: effectiveAsOfDate } };
  const paymentDateFilter = { paymentDate: { lte: effectiveAsOfDate } };
  const borrowDateFilter = { borrowDate: { lte: effectiveAsOfDate } };
  const repaymentDateFilter = { repaymentDate: { lte: effectiveAsOfDate } };

  const [
    incoming,
    outgoing,
    transfersIn,
    installmentsDue,
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
    prisma.installment.aggregate({
      _sum: { amount: true },
      where: { purchase: { card: { defaultPaymentAccountId: accountId } }, ...dueDateFilter },
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
    .minus(installmentsDue._sum.amount ?? 0)
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
