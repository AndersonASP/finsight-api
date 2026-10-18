import { Prisma } from "@prisma/client";
import { prisma } from "../../core/db/prisma.js";
import { addMonthsClamped, startOfUtcDay } from "../../core/http/date.js";
import { AppError } from "../../core/http/errors.js";
import { getAccountBalance, getInvestmentValue } from "../accounts/accounts.service.js";
import { getMonthlyTotals } from "../reports/reports.service.js";
import { computeLoanState } from "../reserve-loans/interest.js";
import { getDebtOutstanding, isExpensiveDebt } from "./debt-outstanding.js";

const ZERO = new Prisma.Decimal(0);
const DAY_MS = 86_400_000;

/** A financial net worth change smaller than this (either way) reads as "estável". */
export const STABLE_CHANGE_THRESHOLD = new Prisma.Decimal(50);

/** After this many days an informed value is flagged "atualize". */
const STALE_DAYS = {
  investment: 30,
  a_receber: 90,
  bem: 180,
} as const;

export type ItemSource = "calculado" | "informado";

export interface WealthItem {
  id: string;
  kind: "account" | "asset" | "debt" | "card";
  name: string;
  value: string;
  source: ItemSource;
  /** YYYY-MM-DD the value refers to. */
  asOf: string | null;
  stale: boolean;
  note: string | null;
  /** Extra numbers for the item (debt progress, asset kind, …). */
  details?: Record<string, unknown>;
}

export interface WealthGroup {
  group: string;
  label: string;
  total: string;
  items: WealthItem[];
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const ageInDays = (d: Date, today: Date) => Math.floor((today.getTime() - d.getTime()) / DAY_MS);

function group(groupKey: string, label: string, items: WealthItem[]): WealthGroup {
  const total = items.reduce((sum, i) => sum.plus(i.value), ZERO);
  return { group: groupKey, label, total: total.toFixed(2), items };
}

// ------------------------------------------------------------------ assets

async function accountGroups(userId: string, today: Date) {
  const accounts = await prisma.account.findMany({ where: { userId, isArchived: false }, orderBy: { createdAt: "asc" } });
  const disponivel: WealthItem[] = [];
  const reserva: WealthItem[] = [];
  const investimentos: WealthItem[] = [];

  for (const account of accounts) {
    if (account.type === "investment") {
      const { value, valuedAt } = await getInvestmentValue(userId, account.id, today);
      investimentos.push({
        id: account.id,
        kind: "account",
        name: account.name,
        value: value.toFixed(2),
        source: "informado",
        asOf: iso(valuedAt),
        stale: !valuedAt || ageInDays(valuedAt, today) > STALE_DAYS.investment,
        note: valuedAt
          ? "Último valor informado + aportes e resgates depois dele"
          : "Valor nunca atualizado — os rendimentos não estão incluídos",
      });
      continue;
    }
    const item: WealthItem = {
      id: account.id,
      kind: "account",
      name: account.name,
      value: (await getAccountBalance(userId, account.id, today)).toFixed(2),
      source: "calculado",
      asOf: iso(today),
      stale: false,
      note: "Pelos lançamentos",
    };
    (account.type === "savings_reserve" ? reserva : disponivel).push(item);
  }
  return { disponivel, reserva, investimentos };
}

async function informedAssetGroups(userId: string, today: Date) {
  const assets = await prisma.asset.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  const aReceber: WealthItem[] = [];
  const bens: WealthItem[] = [];
  for (const asset of assets) {
    const isReceivable = asset.kind === "a_receber";
    const maxAge = isReceivable ? STALE_DAYS.a_receber : STALE_DAYS.bem;
    (isReceivable ? aReceber : bens).push({
      id: asset.id,
      kind: "asset",
      name: asset.name,
      value: new Prisma.Decimal(asset.value).toFixed(2),
      source: "informado",
      asOf: iso(asset.valuedAt),
      stale: ageInDays(asset.valuedAt, today) > maxAge,
      note: isReceivable ? "Valor a receber informado" : "Valor estimado informado",
      details: { assetKind: asset.kind, isLiquid: asset.isLiquid, notes: asset.notes },
    });
  }
  return { aReceber, bens, assets };
}

// ------------------------------------------------------------- liabilities

async function debtGroups(userId: string, today: Date) {
  const debts = await prisma.debt.findMany({ where: { userId, status: { not: "paga" } }, orderBy: { createdAt: "asc" } });
  const parcelaFixa: WealthItem[] = [];
  const saldoVariavel: WealthItem[] = [];
  let monthlyInterest = ZERO;
  let expensiveDebt = ZERO;
  for (const debt of debts) {
    const outstanding = getDebtOutstanding(debt, today);
    if (outstanding.monthlyInterestCost) monthlyInterest = monthlyInterest.plus(outstanding.monthlyInterestCost);
    if (isExpensiveDebt(debt)) expensiveDebt = expensiveDebt.plus(outstanding.value);
    const item: WealthItem = {
      id: debt.id,
      kind: "debt",
      name: debt.creditor,
      value: outstanding.value.toFixed(2),
      source: outstanding.source,
      asOf: iso(outstanding.asOf),
      stale: outstanding.stale,
      note: outstanding.note,
      details: {
        debtType: debt.type,
        debtKind: debt.kind,
        installmentAmount: debt.installmentAmount ? new Prisma.Decimal(debt.installmentAmount).toFixed(2) : null,
        installmentsPaid: outstanding.installmentsPaid,
        installmentsTotal: outstanding.installmentsTotal,
        remainingInstallmentsSum: outstanding.remainingInstallmentsSum?.toFixed(2) ?? null,
        nextDueDate: iso(outstanding.nextDueDate),
        endDate: iso(outstanding.endDate),
        monthlyInterestRate: debt.monthlyInterestRate ? new Prisma.Decimal(debt.monthlyInterestRate).toFixed(3) : null,
        monthlyInterestCost: outstanding.monthlyInterestCost?.toFixed(2) ?? null,
      },
    };
    (outstanding.installmentsTotal != null ? parcelaFixa : saldoVariavel).push(item);
  }
  return { parcelaFixa, saldoVariavel, debts, monthlyInterest, expensiveDebt };
}

/**
 * Card purchases already made whose installments fall due after today — the
 * still-unpaid part of open invoices plus future parcelas. Future occurrences
 * of a subscription (purchaseDate after today) are commitments, not debt.
 */
async function cardGroup(userId: string, today: Date) {
  const installments = await prisma.installment.findMany({
    where: { dueDate: { gt: today }, purchase: { userId, purchaseDate: { lte: today } } },
    select: { amount: true, purchase: { select: { card: { select: { id: true, name: true } } } } },
  });
  const byCard = new Map<string, { name: string; total: Prisma.Decimal; count: number }>();
  for (const i of installments) {
    const card = i.purchase.card;
    const entry = byCard.get(card.id) ?? { name: card.name, total: ZERO, count: 0 };
    entry.total = entry.total.plus(i.amount);
    entry.count++;
    byCard.set(card.id, entry);
  }
  return [...byCard.entries()].map(
    ([id, { name, total, count }]): WealthItem => ({
      id,
      kind: "card",
      name,
      value: total.toFixed(2),
      source: "calculado",
      asOf: iso(today),
      stale: false,
      note: `${count} ${count === 1 ? "parcela a vencer" : "parcelas a vencer"} de compras já feitas`,
    })
  );
}

async function reserveLoansOwed(userId: string, today: Date) {
  const loans = await prisma.reserveLoan.findMany({
    where: { userId, status: "active" },
    include: { repayments: true },
  });
  return loans.reduce((sum, loan) => sum.plus(computeLoanState(loan, loan.repayments, today).totalOwed), ZERO);
}

// -------------------------------------------------------------- indicators

/**
 * Average monthly cost of living over the last 3 complete months (saídas +
 * diário + cartão — economia is saving, not cost). Months with no spending
 * at all (before the user started) are left out of the average.
 */
export async function averageMonthlyCost(userId: string, today: Date) {
  const thisMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const costs: Prisma.Decimal[] = [];
  for (let i = 1; i <= 3; i++) {
    const month = addMonthsClamped(thisMonth, -i);
    const totals = await getMonthlyTotals(userId, month.getUTCFullYear(), month.getUTCMonth() + 1);
    const cost = new Prisma.Decimal(totals.saidas).plus(totals.diario).plus(totals.cartao);
    if (cost.greaterThan(0)) costs.push(cost);
  }
  if (costs.length === 0) return null;
  return costs.reduce((a, b) => a.plus(b), ZERO).dividedBy(costs.length);
}

/**
 * Average monthly result (entradas − custo de vida) over the last 3 complete
 * months with any activity — how fast the financial net worth moves while
 * there's no snapshot history yet. Economia is a transfer between the user's
 * own accounts, so it doesn't count either way.
 */
export async function averageMonthlyResult(userId: string, today: Date) {
  const thisMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const results: Prisma.Decimal[] = [];
  for (let i = 1; i <= 3; i++) {
    const month = addMonthsClamped(thisMonth, -i);
    const totals = await getMonthlyTotals(userId, month.getUTCFullYear(), month.getUTCMonth() + 1);
    const entradas = new Prisma.Decimal(totals.entradas);
    const cost = new Prisma.Decimal(totals.saidas).plus(totals.diario).plus(totals.cartao);
    if (entradas.greaterThan(0) || cost.greaterThan(0)) results.push(entradas.minus(cost));
  }
  if (results.length === 0) return null;
  return results.reduce((a, b) => a.plus(b), ZERO).dividedBy(results.length);
}

export async function getWealth(userId: string, now = new Date()) {
  const today = startOfUtcDay(now);
  const [{ disponivel, reserva, investimentos }, { aReceber, bens, assets }, { parcelaFixa, saldoVariavel, monthlyInterest, expensiveDebt }, cartao] =
    await Promise.all([
      accountGroups(userId, today),
      informedAssetGroups(userId, today),
      debtGroups(userId, today),
      cardGroup(userId, today),
    ]);

  const assetGroups = [
    group("disponivel", "Disponível", disponivel),
    group("reserva", "Reserva", reserva),
    group("investimentos", "Investimentos", investimentos),
    group("a_receber", "A receber", aReceber),
    group("bens", "Bens", bens),
  ].filter((g) => g.items.length > 0);
  const liabilityGroups = [
    group("parcela_fixa", "Parcelados e financiamentos", parcelaFixa),
    group("cartao", "Cartões (parcelas a vencer)", cartao),
    group("saldo_variavel", "Saldos devedores", saldoVariavel),
  ].filter((g) => g.items.length > 0);

  const sum = (groups: WealthGroup[]) => groups.reduce((s, g) => s.plus(g.total), ZERO);
  const totalAssets = sum(assetGroups);
  const totalLiabilities = sum(liabilityGroups);
  const netWorth = totalAssets.minus(totalLiabilities);
  const illiquid = assets.filter((a) => !a.isLiquid).reduce((s, a) => s.plus(a.value), ZERO);
  const financialNetWorth = netWorth.minus(illiquid);

  const reserveTotal = new Prisma.Decimal(group("reserva", "", reserva).total);
  const avgCost = await averageMonthlyCost(userId, today);
  const reserveMonths = avgCost && avgCost.greaterThan(0) ? reserveTotal.dividedBy(avgCost) : null;

  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() + 1;
  await prisma.netWorthSnapshot.upsert({
    where: { userId_year_month: { userId, year, month } },
    create: { userId, year, month, assets: totalAssets, liabilities: totalLiabilities, netWorth, financialNetWorth },
    update: { assets: totalAssets, liabilities: totalLiabilities, netWorth, financialNetWorth },
  });
  const previous = await prisma.netWorthSnapshot.findFirst({
    where: { userId, OR: [{ year: { lt: year } }, { year, month: { lt: month } }] },
    orderBy: [{ year: "desc" }, { month: "desc" }],
  });

  // "Ficando mais rico ou mais pobre": the financial net worth (bens don't
  // pay bills) against last month's snapshot, or — with no history yet —
  // the average monthly result of the last months.
  const previousFinancial =
    previous?.financialNetWorth != null ? new Prisma.Decimal(previous.financialNetWorth) : null;
  const avgResult = previousFinancial ? null : await averageMonthlyResult(userId, today);
  const change = previousFinancial ? financialNetWorth.minus(previousFinancial) : avgResult;
  const tendencia =
    change == null
      ? null
      : change.abs().lessThan(STABLE_CHANGE_THRESHOLD)
        ? "estavel"
        : change.greaterThan(0)
          ? "crescendo"
          : "caindo";

  const allItems = [...assetGroups, ...liabilityGroups].flatMap((g) => g.items);
  return {
    asOf: iso(today),
    netWorth: netWorth.toFixed(2),
    financialNetWorth: financialNetWorth.toFixed(2),
    totalAssets: totalAssets.toFixed(2),
    totalLiabilities: totalLiabilities.toFixed(2),
    previousNetWorth: previous ? new Prisma.Decimal(previous.netWorth).toFixed(2) : null,
    previousNetWorthMonth: previous ? { year: previous.year, month: previous.month } : null,
    reserveMonths: reserveMonths?.toFixed(1) ?? null,
    averageMonthlyCost: avgCost?.toFixed(2) ?? null,
    reserveLoansOwed: (await reserveLoansOwed(userId, today)).toFixed(2),
    diagnostico: {
      tendencia,
      variacao: change?.toFixed(2) ?? null,
      /** "historico": vs. `desde`'s snapshot; "media_mensal": average per month (no history yet). */
      base: change == null ? null : previousFinancial ? "historico" : "media_mensal",
      desde: previousFinancial && previous ? { year: previous.year, month: previous.month } : null,
      jurosMensais: monthlyInterest.toFixed(2),
      dividaCara: expensiveDebt.toFixed(2),
      reserva: reserveTotal.toFixed(2),
      disponivelNegativo: new Prisma.Decimal(group("disponivel", "", disponivel).total).lessThan(0),
    },
    staleCount: allItems.filter((i) => i.stale).length,
    assets: assetGroups,
    liabilities: liabilityGroups,
  };
}

export async function getWealthHistory(userId: string, months: number) {
  const snapshots = await prisma.netWorthSnapshot.findMany({
    where: { userId },
    orderBy: [{ year: "desc" }, { month: "desc" }],
    take: months,
  });
  return snapshots.reverse().map((s) => ({
    year: s.year,
    month: s.month,
    assets: new Prisma.Decimal(s.assets).toFixed(2),
    liabilities: new Prisma.Decimal(s.liabilities).toFixed(2),
    netWorth: new Prisma.Decimal(s.netWorth).toFixed(2),
  }));
}

// ------------------------------------------------------------- asset CRUD

export interface AssetInput {
  name: string;
  kind: "imovel" | "veiculo" | "a_receber" | "outro";
  value: string;
  valuedAt: Date;
  isLiquid?: boolean;
  notes?: string;
}

export function listAssets(userId: string) {
  return prisma.asset.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
}

export function createAsset(userId: string, input: AssetInput) {
  return prisma.asset.create({
    data: { userId, ...input, isLiquid: input.isLiquid ?? input.kind === "a_receber" },
  });
}

async function getOwnedAsset(userId: string, id: string) {
  const asset = await prisma.asset.findUnique({ where: { id } });
  if (!asset || asset.userId !== userId) throw AppError.notFound("Asset not found");
  return asset;
}

export async function updateAsset(userId: string, id: string, input: Partial<AssetInput>) {
  await getOwnedAsset(userId, id);
  return prisma.asset.update({ where: { id }, data: input });
}

export async function deleteAsset(userId: string, id: string) {
  await getOwnedAsset(userId, id);
  await prisma.asset.delete({ where: { id } });
}
