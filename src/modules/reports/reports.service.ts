import { Prisma } from "@prisma/client";
import { prisma } from "../../core/db/prisma.js";
import { addDays, addMonthsClamped, daysInMonth, startOfUtcDay } from "../../core/http/date.js";
import { getAccountBalance } from "../accounts/accounts.service.js";
import { getBudgetSummary } from "../budget/budget.service.js";

const ZERO = new Prisma.Decimal(0);

/**
 * "Saldo" (the consolidated balance shown in Saldos/day-detail) is the user's
 * free, day-to-day money — only `checking` accounts count toward it. Reserve
 * and investment accounts are deliberately excluded: a transfer into them
 * still reduces this total (the outgoing side is a checking account), but
 * their own balance isn't added back, so moving money there visibly reduces
 * "dinheiro livre" without needing a separate patrimony calculation here —
 * that distinction already lives in the savings-goals module (RF-14).
 */
export async function getTotalBalance(userId: string, asOfDate?: Date) {
  const accounts = await prisma.account.findMany({ where: { userId, isArchived: false, type: "checking" } });
  let total = ZERO;
  for (const account of accounts) {
    total = total.plus(await getAccountBalance(userId, account.id, asOfDate));
  }
  return total;
}

/**
 * The running saldo's per-month anchor (below) is normally the *real*
 * balance as of the day before the viewed month — correct as long as that
 * day isn't itself a future, still-forecasted day. When it is (viewing a
 * month entirely after today), the real balance alone drops the "previsão
 * de diário" that was projected into every day between today and that
 * anchor, causing a visible jump at the month boundary. This re-applies
 * exactly that projection for the gap, day by day (each day's own calendar
 * month supplies its own daily average), so the saldo carries over
 * continuously instead of snapping back to "reality" at the seam.
 */
async function getForecastAdjustmentBetween(userId: string, fromExclusive: Date, toInclusive: Date) {
  if (fromExclusive.getTime() >= toInclusive.getTime()) return ZERO;
  const rangeStart = addDays(fromExclusive, 1);

  const realDiarioTransactions = await prisma.transaction.findMany({
    where: { userId, type: "diario", date: { gte: rangeStart, lte: toInclusive } },
    select: { date: true, amount: true },
  });
  const realDiarioByDay = new Map<string, Prisma.Decimal>();
  for (const t of realDiarioTransactions) {
    const key = t.date.toISOString().slice(0, 10);
    realDiarioByDay.set(key, (realDiarioByDay.get(key) ?? ZERO).plus(t.amount));
  }

  const dailyAverageByMonth = new Map<string, Prisma.Decimal>();
  let adjustment = ZERO;
  for (let cursor = rangeStart; cursor.getTime() <= toInclusive.getTime(); cursor = addDays(cursor, 1)) {
    const key = cursor.toISOString().slice(0, 10);
    const real = realDiarioByDay.get(key);
    if (real && !real.isZero()) continue; // a real lançamento that day always wins

    const monthKey = key.slice(0, 7);
    let dailyAverage = dailyAverageByMonth.get(monthKey);
    if (!dailyAverage) {
      const summary = await getBudgetSummary(userId, cursor.getUTCFullYear(), cursor.getUTCMonth() + 1);
      dailyAverage = new Prisma.Decimal(summary.dailyAverage);
      dailyAverageByMonth.set(monthKey, dailyAverage);
    }
    if (dailyAverage.greaterThan(0)) adjustment = adjustment.minus(dailyAverage);
  }
  return adjustment;
}

export interface DailyBalanceDay {
  day: number;
  date: string;
  entrada: string;
  saida: string;
  diario: string;
  diarioIsForecast: boolean;
  economia: string;
  cartao: string;
  saldo: string;
}

/**
 * Per-type columns show raw activity for that day (what happened), while `saldo`
 * is the running *checking-only* balance ("dinheiro livre") — see
 * getTotalBalance. A transfer between two checking accounts nets to zero in
 * `saldo` (money just moved within the pool that counts); a transfer to a
 * reserve/investment account reduces `saldo` (it left the pool) even though
 * it still shows in the `economia` column, same as any other account's activity.
 *
 * Days strictly after today with no real `diario` activity get "previsão de
 * diário"'s flat monthly average projected into both `diario` (flagged via
 * `diarioIsForecast`) and `saldo` — only for the consolidated view (budget
 * items aren't tied to any one account). Today itself never gets this: the
 * day starts with nothing spent yet, so it stays at its real (zero) value.
 * A real transaction on a future day always wins over the projection.
 */
export async function getDailyBalance(userId: string, year: number, month: number, accountId?: string) {
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));
  const dayBeforeMonth = new Date(monthStart.getTime() - 24 * 60 * 60 * 1000);

  let runningBalance = accountId
    ? await getAccountBalance(userId, accountId, dayBeforeMonth)
    : await getTotalBalance(userId, dayBeforeMonth);

  if (!accountId) {
    const today = startOfUtcDay(new Date());
    if (dayBeforeMonth.getTime() > today.getTime()) {
      runningBalance = runningBalance.plus(await getForecastAdjustmentBetween(userId, today, dayBeforeMonth));
    }
  }

  const transactions = await prisma.transaction.findMany({
    where: {
      userId,
      date: { gte: monthStart, lt: monthEnd },
      ...(accountId ? { OR: [{ accountId }, { counterpartAccountId: accountId }] } : {}),
    },
  });

  // Card purchases are the "despesa original" (RF-12): shown here at purchase
  // time for the full amount, same as `diario`. They never move `saldo` on
  // their own — only an actual invoice payment (below) touches cash.
  const purchases = await prisma.purchase.findMany({
    where: { userId, purchaseDate: { gte: monthStart, lt: monthEnd } },
  });

  const invoicePayments = await prisma.invoicePayment.findMany({
    where: {
      invoice: { userId },
      paymentDate: { gte: monthStart, lt: monthEnd },
      ...(accountId ? { accountId } : {}),
    },
  });

  // Debt payments and reserve-loan movements also move real cash (see
  // getAccountBalance) but, unlike invoice payments above, were missing here
  // entirely — so paying a debt or a reserve loan moved the *next* month's
  // anchor (which recomputes via getAccountBalance) but never this month's
  // own day-by-day saldo.
  const debtPayments = await prisma.debtPayment.findMany({
    where: {
      debt: { userId },
      paymentDate: { gte: monthStart, lt: monthEnd },
      ...(accountId ? { accountId } : {}),
    },
  });

  const reserveLoanBorrows = await prisma.reserveLoan.findMany({
    where: {
      userId,
      borrowDate: { gte: monthStart, lt: monthEnd },
      ...(accountId ? { OR: [{ reserveAccountId: accountId }, { destinationAccountId: accountId }] } : {}),
    },
  });

  const reserveLoanRepayments = await prisma.reserveLoanRepayment.findMany({
    where: {
      loan: { userId },
      repaymentDate: { gte: monthStart, lt: monthEnd },
      ...(accountId ? { loan: { OR: [{ reserveAccountId: accountId }, { destinationAccountId: accountId }] } } : {}),
    },
    include: { loan: true },
  });

  // Also used (beyond the aggregate path's checking-only restriction, see
  // getTotalBalance's docstring) to inject each account's initialBalance on
  // its actual creation day below.
  const accounts = await prisma.account.findMany({
    where: { userId },
    select: { id: true, type: true, createdAt: true, initialBalance: true },
  });
  const accountTypeById = new Map(accounts.map((a) => [a.id, a.type]));

  const numDays = daysInMonth(year, month);
  const columns = Array.from({ length: numDays }, () => ({
    entrada: ZERO,
    saida: ZERO,
    diario: ZERO,
    economia: ZERO,
    cartao: ZERO,
  }));
  const deltas = Array.from({ length: numDays }, () => ZERO);

  for (const p of purchases) {
    const dayIndex = p.purchaseDate.getUTCDate() - 1;
    columns[dayIndex].cartao = columns[dayIndex].cartao.plus(new Prisma.Decimal(p.amount));
  }

  for (const t of transactions) {
    const dayIndex = t.date.getUTCDate() - 1;
    const amount = new Prisma.Decimal(t.amount);
    const isPrimary = !accountId || t.accountId === accountId;
    const isCounterpart = accountId && t.counterpartAccountId === accountId;

    if (isPrimary) {
      if (t.type === "entrada") columns[dayIndex].entrada = columns[dayIndex].entrada.plus(amount);
      else if (t.type === "saida") columns[dayIndex].saida = columns[dayIndex].saida.plus(amount);
      else if (t.type === "diario") columns[dayIndex].diario = columns[dayIndex].diario.plus(amount);
      else if (t.type === "economia") columns[dayIndex].economia = columns[dayIndex].economia.plus(amount);
    }

    if (accountId) {
      if (isPrimary) {
        if (t.type === "entrada") deltas[dayIndex] = deltas[dayIndex].plus(amount);
        else deltas[dayIndex] = deltas[dayIndex].minus(amount);
      } else if (isCounterpart) {
        deltas[dayIndex] = deltas[dayIndex].plus(amount);
      }
    } else {
      // Mirrors getAccountBalance summed over checking accounts only: a
      // transaction on a checking account always moves the aggregate; an
      // `economia` transfer whose *counterpart* is checking adds it back
      // (money arriving there), regardless of the source account's type.
      const isCheckingPrimary = accountTypeById.get(t.accountId) === "checking";
      const isCheckingCounterpart = t.counterpartAccountId != null && accountTypeById.get(t.counterpartAccountId) === "checking";

      if (isCheckingPrimary) {
        if (t.type === "entrada") deltas[dayIndex] = deltas[dayIndex].plus(amount);
        else deltas[dayIndex] = deltas[dayIndex].minus(amount);
      }
      if (isCheckingCounterpart && t.type === "economia") {
        deltas[dayIndex] = deltas[dayIndex].plus(amount);
      }
    }
  }

  for (const payment of invoicePayments) {
    const dayIndex = payment.paymentDate.getUTCDate() - 1;
    deltas[dayIndex] = deltas[dayIndex].minus(new Prisma.Decimal(payment.amount));
  }

  for (const payment of debtPayments) {
    const dayIndex = payment.paymentDate.getUTCDate() - 1;
    deltas[dayIndex] = deltas[dayIndex].minus(new Prisma.Decimal(payment.amount));
  }

  for (const loan of reserveLoanBorrows) {
    const dayIndex = loan.borrowDate.getUTCDate() - 1;
    const principal = new Prisma.Decimal(loan.principal);
    if (accountId) {
      if (loan.reserveAccountId === accountId) deltas[dayIndex] = deltas[dayIndex].minus(principal);
      if (loan.destinationAccountId === accountId) deltas[dayIndex] = deltas[dayIndex].plus(principal);
    } else {
      if (accountTypeById.get(loan.reserveAccountId) === "checking") deltas[dayIndex] = deltas[dayIndex].minus(principal);
      if (accountTypeById.get(loan.destinationAccountId) === "checking") deltas[dayIndex] = deltas[dayIndex].plus(principal);
    }
  }

  for (const repayment of reserveLoanRepayments) {
    const dayIndex = repayment.repaymentDate.getUTCDate() - 1;
    const amount = new Prisma.Decimal(repayment.amount);
    if (accountId) {
      if (repayment.loan.reserveAccountId === accountId) deltas[dayIndex] = deltas[dayIndex].plus(amount);
      if (repayment.loan.destinationAccountId === accountId) deltas[dayIndex] = deltas[dayIndex].minus(amount);
    } else {
      if (accountTypeById.get(repayment.loan.reserveAccountId) === "checking") deltas[dayIndex] = deltas[dayIndex].plus(amount);
      if (accountTypeById.get(repayment.loan.destinationAccountId) === "checking") deltas[dayIndex] = deltas[dayIndex].minus(amount);
    }
  }

  // The month-start anchor (above) excludes an account's initialBalance when
  // the account was created after it (see getAccountBalance) — so if that
  // creation day falls within *this* month, it never otherwise appears.
  // Inject it as a one-time delta exactly on that day instead of losing it.
  for (const account of accounts) {
    if (accountId ? account.id !== accountId : account.type !== "checking") continue;
    const createdDay = startOfUtcDay(account.createdAt);
    if (createdDay.getTime() < monthStart.getTime() || createdDay.getTime() >= monthEnd.getTime()) continue;
    const dayIndex = createdDay.getUTCDate() - 1;
    deltas[dayIndex] = deltas[dayIndex].plus(new Prisma.Decimal(account.initialBalance));
  }

  const isForecast = new Array<boolean>(numDays).fill(false);
  if (!accountId) {
    const budgetSummary = await getBudgetSummary(userId, year, month);
    const dailyAverage = new Prisma.Decimal(budgetSummary.dailyAverage);
    if (dailyAverage.greaterThan(0)) {
      const today = startOfUtcDay(new Date());
      for (let i = 0; i < numDays; i++) {
        const dayDate = new Date(Date.UTC(year, month - 1, i + 1));
        if (columns[i].diario.isZero() && dayDate.getTime() > today.getTime()) {
          columns[i].diario = dailyAverage;
          deltas[i] = deltas[i].minus(dailyAverage);
          isForecast[i] = true;
        }
      }
    }
  }

  const days: DailyBalanceDay[] = [];
  for (let i = 0; i < numDays; i++) {
    runningBalance = runningBalance.plus(deltas[i]);
    const day = i + 1;
    days.push({
      day,
      date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      entrada: columns[i].entrada.toFixed(2),
      saida: columns[i].saida.toFixed(2),
      diario: columns[i].diario.toFixed(2),
      diarioIsForecast: isForecast[i],
      economia: columns[i].economia.toFixed(2),
      cartao: columns[i].cartao.toFixed(2),
      saldo: runningBalance.toFixed(2),
    });
  }

  return days;
}

export interface DayDetailItem {
  id: string;
  type: "entrada" | "saida" | "diario" | "economia" | "cartao";
  description: string;
  date: string;
  amount: string;
  categoryId: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  installment: { sequence: number; count: number } | null;
  recurring: { seriesId: string; occurrenceIndex: number } | null;
}

/**
 * The day's individual line items — for a drill-down "what happened this
 * day" view, not the aggregate columns above. Regular transactions are dated
 * by `date`; card installments are dated by their own `dueDate` (when that
 * specific installment is billed), which is intentionally independent of the
 * `cartao` aggregate column (dated by purchase time, per RF-12).
 */
export async function getDayDetail(userId: string, date: Date): Promise<DayDetailItem[]> {
  const nextDay = new Date(date.getTime() + 24 * 60 * 60 * 1000);

  const [transactions, installments] = await Promise.all([
    prisma.transaction.findMany({
      where: { userId, date: { gte: date, lt: nextDay } },
      include: { category: true },
    }),
    prisma.installment.findMany({
      where: { purchase: { userId }, dueDate: { gte: date, lt: nextDay } },
      include: { purchase: { include: { category: true } } },
    }),
  ]);

  const items: DayDetailItem[] = [];

  for (const t of transactions) {
    items.push({
      id: t.id,
      type: t.type,
      description: t.description?.trim() ? t.description : t.type,
      date: t.date.toISOString().slice(0, 10),
      amount: new Prisma.Decimal(t.amount).toFixed(2),
      categoryId: t.categoryId,
      categoryName: t.category?.name ?? null,
      categoryColor: t.category?.color ?? null,
      installment: null,
      recurring:
        t.recurringTransactionId != null && t.occurrenceIndex != null
          ? { seriesId: t.recurringTransactionId, occurrenceIndex: t.occurrenceIndex }
          : null,
    });
  }

  for (const installment of installments) {
    items.push({
      id: installment.id,
      type: "cartao",
      description: installment.purchase.description,
      date: installment.dueDate.toISOString().slice(0, 10),
      amount: new Prisma.Decimal(installment.amount).toFixed(2),
      categoryId: installment.purchase.categoryId,
      categoryName: installment.purchase.category?.name ?? null,
      categoryColor: installment.purchase.category?.color ?? null,
      installment: { sequence: installment.sequence, count: installment.purchase.installmentsCount },
      recurring: null,
    });
  }

  items.sort((a, b) => Number(b.amount) - Number(a.amount));
  return items;
}

export interface MonthlyTotals {
  entradas: string;
  saidas: string;
  diario: string;
  economia: string;
  cartao: string;
  performance: string;
  custoDeVida: string;
  rendaExcedeCustoDeVida: boolean;
  economizadoPercent: string;
  diarioMedioRealizado: string;
  diarioMedioPrevisto: string;
}

export async function getMonthlyTotals(userId: string, year: number, month: number): Promise<MonthlyTotals> {
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));

  const transactions = await prisma.transaction.findMany({
    where: { userId, date: { gte: monthStart, lt: monthEnd } },
  });
  const purchases = await prisma.purchase.findMany({
    where: { userId, purchaseDate: { gte: monthStart, lt: monthEnd } },
  });

  let entradas = ZERO;
  let saidas = ZERO;
  let diario = ZERO;
  let economia = ZERO;
  let cartao = ZERO;

  for (const t of transactions) {
    const amount = new Prisma.Decimal(t.amount);
    if (t.type === "entrada") entradas = entradas.plus(amount);
    else if (t.type === "saida") saidas = saidas.plus(amount);
    else if (t.type === "diario") diario = diario.plus(amount);
    else if (t.type === "economia") economia = economia.plus(amount);
  }
  for (const p of purchases) {
    cartao = cartao.plus(new Prisma.Decimal(p.amount));
  }

  const performance = entradas.minus(saidas).minus(diario).minus(economia).minus(cartao);
  const custoDeVida = saidas.plus(diario).plus(economia).plus(cartao);
  const economizadoPercent = entradas.isZero() ? ZERO : economia.dividedBy(entradas).times(100);

  const today = new Date();
  const isCurrentMonth = today.getUTCFullYear() === year && today.getUTCMonth() + 1 === month;
  const elapsedDays = isCurrentMonth ? today.getUTCDate() : daysInMonth(year, month);
  const diarioMedioRealizado = elapsedDays > 0 ? diario.dividedBy(elapsedDays) : ZERO;

  const budgetSummary = await getBudgetSummary(userId, year, month);

  return {
    entradas: entradas.toFixed(2),
    saidas: saidas.toFixed(2),
    diario: diario.toFixed(2),
    economia: economia.toFixed(2),
    cartao: cartao.toFixed(2),
    performance: performance.toFixed(2),
    custoDeVida: custoDeVida.toFixed(2),
    rendaExcedeCustoDeVida: entradas.greaterThanOrEqualTo(custoDeVida),
    economizadoPercent: economizadoPercent.toFixed(2),
    diarioMedioRealizado: diarioMedioRealizado.toFixed(2),
    diarioMedioPrevisto: budgetSummary.dailyAverage,
  };
}

export interface CategoryBreakdownItem {
  categoryId: string;
  name: string;
  color: string;
  total: string;
}

/**
 * Spend by category for one month, unioning `Transaction` (saida/diario/
 * economia) and `Purchase` — a plain lançamento and a card purchase with the
 * same tag must both count here, unlike categories.service.ts's
 * getCategoryTotal which only ever looked at Transaction.
 */
export async function getCategoryBreakdown(userId: string, year: number, month: number): Promise<CategoryBreakdownItem[]> {
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));

  const [transactions, purchases] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        userId,
        date: { gte: monthStart, lt: monthEnd },
        type: { in: ["saida", "diario", "economia"] },
        categoryId: { not: null },
      },
      include: { category: true },
    }),
    prisma.purchase.findMany({
      where: { userId, purchaseDate: { gte: monthStart, lt: monthEnd }, categoryId: { not: null } },
      include: { category: true },
    }),
  ]);

  const totals = new Map<string, { name: string; color: string; total: Prisma.Decimal }>();
  for (const t of transactions) {
    if (!t.categoryId || !t.category) continue;
    const existing = totals.get(t.categoryId) ?? { name: t.category.name, color: t.category.color, total: ZERO };
    existing.total = existing.total.plus(t.amount);
    totals.set(t.categoryId, existing);
  }
  for (const p of purchases) {
    if (!p.categoryId || !p.category) continue;
    const existing = totals.get(p.categoryId) ?? { name: p.category.name, color: p.category.color, total: ZERO };
    existing.total = existing.total.plus(p.amount);
    totals.set(p.categoryId, existing);
  }

  return [...totals.entries()]
    .map(([categoryId, v]) => ({ categoryId, name: v.name, color: v.color, total: v.total.toFixed(2) }))
    .sort((a, b) => Number(b.total) - Number(a.total));
}

export interface MonthlyTrendPoint {
  year: number;
  month: number;
  entradas: string;
  saidas: string;
  economia: string;
  saldoFinal: string;
}

/**
 * One point per month for the last `months` months (oldest first), so a
 * report screen can chart entradas/saídas/economia and the checking-only
 * saldo (see getTotalBalance) over time instead of being stuck on one month.
 */
export async function getMonthlyTrend(userId: string, months: number): Promise<MonthlyTrendPoint[]> {
  const today = new Date();
  const thisMonthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));

  const points: MonthlyTrendPoint[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const monthStart = addMonthsClamped(thisMonthStart, -i);
    const year = monthStart.getUTCFullYear();
    const month = monthStart.getUTCMonth() + 1;
    const totals = await getMonthlyTotals(userId, year, month);
    const asOfDate = i === 0 ? today : new Date(Date.UTC(year, month - 1, daysInMonth(year, month)));
    const saldoFinal = await getTotalBalance(userId, asOfDate);
    points.push({
      year,
      month,
      entradas: totals.entradas,
      saidas: totals.saidas,
      economia: totals.economia,
      saldoFinal: saldoFinal.toFixed(2),
    });
  }
  return points;
}

export interface BudgetVsActualItem {
  categoryId: string;
  name: string;
  color: string;
  budgeted: string;
  actual: string;
}

/**
 * Compares each category's budgeted amount (from active BudgetItems tied to
 * that category, respecting startsOn/endsOn — the first real use of those
 * fields, previously stored but ignored everywhere) against what was
 * actually spent in that category for the month.
 */
export async function getBudgetVsActual(userId: string, year: number, month: number): Promise<BudgetVsActualItem[]> {
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));

  const [budgetItems, actualBreakdown] = await Promise.all([
    prisma.budgetItem.findMany({
      where: {
        userId,
        active: true,
        categoryId: { not: null },
        AND: [
          { OR: [{ startsOn: null }, { startsOn: { lt: monthEnd } }] },
          { OR: [{ endsOn: null }, { endsOn: { gte: monthStart } }] },
        ],
      },
      include: { category: true },
    }),
    getCategoryBreakdown(userId, year, month),
  ]);

  const actualByCategory = new Map(actualBreakdown.map((c) => [c.categoryId, c.total]));

  const budgetedByCategory = new Map<string, { name: string; color: string; budgeted: Prisma.Decimal }>();
  for (const item of budgetItems) {
    if (!item.categoryId || !item.category) continue;
    const existing =
      budgetedByCategory.get(item.categoryId) ?? { name: item.category.name, color: item.category.color, budgeted: ZERO };
    existing.budgeted = existing.budgeted.plus(item.amount);
    budgetedByCategory.set(item.categoryId, existing);
  }

  return [...budgetedByCategory.entries()].map(([categoryId, v]) => ({
    categoryId,
    name: v.name,
    color: v.color,
    budgeted: v.budgeted.toFixed(2),
    actual: actualByCategory.get(categoryId) ?? "0.00",
  }));
}
