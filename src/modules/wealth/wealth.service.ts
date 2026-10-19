import { Prisma } from "@prisma/client";
import { prisma } from "../../core/db/prisma.js";
import { addMonthsClamped, startOfUtcDay } from "../../core/http/date.js";
import { AppError } from "../../core/http/errors.js";
import { getAccountBalance, getInvestmentValue } from "../accounts/accounts.service.js";
import { costOfLiving, getMonthlyTotals } from "../reports/reports.service.js";
import { computeLoanState } from "../reserve-loans/interest.js";
import { getReserveTargetMonths } from "../settings/settings.service.js";
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
 * Average monthly custo de vida puro (see costOfLiving) over the last 3
 * complete months. Months with no spending
 * at all (before the user started) are left out of the average.
 */
export async function averageMonthlyCost(userId: string, today: Date) {
  const thisMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const costs: Prisma.Decimal[] = [];
  for (let i = 1; i <= 3; i++) {
    const month = addMonthsClamped(thisMonth, -i);
    const totals = await getMonthlyTotals(userId, month.getUTCFullYear(), month.getUTCMonth() + 1);
    const cost = costOfLiving(totals);
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
    const cost = costOfLiving(totals);
    if (entradas.greaterThan(0) || cost.greaterThan(0)) results.push(entradas.minus(cost));
  }
  if (results.length === 0) return null;
  return results.reduce((a, b) => a.plus(b), ZERO).dividedBy(results.length);
}

/** Método: patrimônio líquido under this share of the total is the warning light. */
export const NET_WORTH_MIN_PERCENT = 40;

const sumGroups = (groups: WealthGroup[]) => groups.reduce((s, g) => s.plus(g.total), ZERO);

/**
 * The patrimônio as of `asOf`, as the método defines it — no side effects:
 *
 * - **total** = every asset group (disponível, reserva, investimentos,
 *   a receber, bens);
 * - **saldo devedor** (`totalLiabilities`) = registered debts only;
 * - **líquido** = total − saldo devedor, and its share of the total
 *   (`netWorthPercent`, warning under 40%);
 * - **compromissos do cartão** (installments still to come of purchases
 *   already made) are kept apart: not saldo devedor, but they do come out of
 *   the **financeiro** (líquido − bens ilíquidos − compromissos), the money
 *   that's actually free.
 */
export async function computeWealth(userId: string, asOf: Date) {
  const [{ disponivel, reserva, investimentos }, { aReceber, bens, assets }, { parcelaFixa, saldoVariavel, monthlyInterest, expensiveDebt }, cartao] =
    await Promise.all([
      accountGroups(userId, asOf),
      informedAssetGroups(userId, asOf),
      debtGroups(userId, asOf),
      cardGroup(userId, asOf),
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
    group("saldo_variavel", "Saldos devedores", saldoVariavel),
  ].filter((g) => g.items.length > 0);
  const commitmentGroups = [group("cartao", "Compromissos do cartão (parcelas a vencer)", cartao)].filter(
    (g) => g.items.length > 0
  );

  const totalAssets = sumGroups(assetGroups);
  const totalLiabilities = sumGroups(liabilityGroups);
  const cardCommitments = sumGroups(commitmentGroups);
  const netWorth = totalAssets.minus(totalLiabilities);
  const netWorthPercent = totalAssets.greaterThan(0) ? netWorth.dividedBy(totalAssets).times(100) : null;
  const illiquid = assets.filter((a) => !a.isLiquid).reduce((s, a) => s.plus(a.value), ZERO);
  const financialNetWorth = netWorth.minus(illiquid).minus(cardCommitments);

  return {
    assetGroups,
    liabilityGroups,
    commitmentGroups,
    totalAssets,
    totalLiabilities,
    cardCommitments,
    netWorth,
    netWorthPercent,
    financialNetWorth,
    reserveTotal: new Prisma.Decimal(group("reserva", "", reserva).total),
    disponivelTotal: new Prisma.Decimal(group("disponivel", "", disponivel).total),
    monthlyInterest,
    expensiveDebt,
  };
}

/** Fits the snapshot column (Decimal 7,2): only absurd ratios (tiny assets, big debt) get capped. */
export const snapshotPercent = (p: Prisma.Decimal | null) =>
  p == null ? null : Prisma.Decimal.min(99999, Prisma.Decimal.max(-99999, p)).toDecimalPlaces(2);

const trendOf = (change: Prisma.Decimal | null) =>
  change == null
    ? null
    : change.abs().lessThan(STABLE_CHANGE_THRESHOLD)
      ? "estavel"
      : change.greaterThan(0)
        ? "crescendo"
        : "caindo";

export async function getWealth(userId: string, now = new Date()) {
  const today = startOfUtcDay(now);
  const w = await computeWealth(userId, today);
  const [avgCost, reserveTargetMonths] = await Promise.all([averageMonthlyCost(userId, today), getReserveTargetMonths(userId)]);
  const reserveMonths = avgCost && avgCost.greaterThan(0) ? w.reserveTotal.dividedBy(avgCost) : null;
  // Método R3: falta = custo de vida × meses desejados − reserva atual.
  const reserveMissing = avgCost ? Prisma.Decimal.max(ZERO, avgCost.times(reserveTargetMonths).minus(w.reserveTotal)) : null;
  const reserveComplete = reserveMonths != null && !reserveMonths.lessThan(reserveTargetMonths);

  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() + 1;
  const figures = {
    assets: w.totalAssets,
    liabilities: w.totalLiabilities,
    netWorth: w.netWorth,
    financialNetWorth: w.financialNetWorth,
    cardCommitments: w.cardCommitments,
    netWorthPercent: snapshotPercent(w.netWorthPercent),
  };
  await prisma.netWorthSnapshot.upsert({
    where: { userId_year_month: { userId, year, month } },
    create: { userId, year, month, ...figures },
    update: figures,
  });
  const previous = await prisma.netWorthSnapshot.findFirst({
    where: { userId, OR: [{ year: { lt: year } }, { year, month: { lt: month } }] },
    orderBy: [{ year: "desc" }, { month: "desc" }],
  });

  // "Ficando mais rico ou mais pobre" (método R7): the TOTAL patrimônio
  // líquido against the last snapshot — so a car losing value or a debt
  // going down shows up, not only cash. With no history yet, the average
  // monthly result of the last months stands in.
  const change = previous ? w.netWorth.minus(previous.netWorth) : await averageMonthlyResult(userId, today);
  const financialChange =
    previous?.financialNetWorth != null ? w.financialNetWorth.minus(previous.financialNetWorth) : null;

  const allItems = [...w.assetGroups, ...w.liabilityGroups, ...w.commitmentGroups].flatMap((g) => g.items);
  return {
    asOf: iso(today),
    netWorth: w.netWorth.toFixed(2),
    netWorthPercent: w.netWorthPercent?.toFixed(1) ?? null,
    netWorthMinPercent: NET_WORTH_MIN_PERCENT,
    /** Método: líquido under 40% of the total — warn (never block). */
    netWorthAlert: w.netWorthPercent != null && w.netWorthPercent.lessThan(NET_WORTH_MIN_PERCENT),
    financialNetWorth: w.financialNetWorth.toFixed(2),
    totalAssets: w.totalAssets.toFixed(2),
    totalLiabilities: w.totalLiabilities.toFixed(2),
    cardCommitments: w.cardCommitments.toFixed(2),
    previousNetWorth: previous ? new Prisma.Decimal(previous.netWorth).toFixed(2) : null,
    previousNetWorthMonth: previous ? { year: previous.year, month: previous.month } : null,
    reserveMonths: reserveMonths?.toFixed(1) ?? null,
    reserveTargetMonths,
    reserveMissing: reserveMissing?.toFixed(2) ?? null,
    reserveComplete,
    averageMonthlyCost: avgCost?.toFixed(2) ?? null,
    reserveLoansOwed: (await reserveLoansOwed(userId, today)).toFixed(2),
    diagnostico: {
      tendencia: trendOf(change),
      variacao: change?.toFixed(2) ?? null,
      /** "historico": vs. `desde`'s snapshot; "media_mensal": average per month (no history yet). */
      base: change == null ? null : previous ? "historico" : "media_mensal",
      desde: previous ? { year: previous.year, month: previous.month } : null,
      /** The same comparison without bens and card commitments — secondary figure. */
      variacaoFinanceira: financialChange?.toFixed(2) ?? null,
      jurosMensais: w.monthlyInterest.toFixed(2),
      dividaCara: w.expensiveDebt.toFixed(2),
      reserva: w.reserveTotal.toFixed(2),
      disponivelNegativo: w.disponivelTotal.lessThan(0),
    },
    staleCount: allItems.filter((i) => i.stale).length,
    assets: w.assetGroups,
    liabilities: w.liabilityGroups,
    commitments: w.commitmentGroups,
  };
}

export async function getWealthHistory(userId: string, months: number) {
  const snapshots = await prisma.netWorthSnapshot.findMany({
    where: { userId },
    orderBy: [{ year: "desc" }, { month: "desc" }],
    take: months,
  });
  const money = (d: Prisma.Decimal.Value | null) => (d == null ? null : new Prisma.Decimal(d).toFixed(2));
  return snapshots.reverse().map((s) => ({
    year: s.year,
    month: s.month,
    assets: money(s.assets),
    liabilities: money(s.liabilities),
    netWorth: money(s.netWorth),
    financialNetWorth: money(s.financialNetWorth),
    cardCommitments: money(s.cardCommitments),
    netWorthPercent: s.netWorthPercent == null ? null : new Prisma.Decimal(s.netWorthPercent).toFixed(1),
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
