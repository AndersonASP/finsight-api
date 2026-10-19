import { Prisma } from "@prisma/client";
import { prisma } from "../../core/db/prisma.js";
import { addDays, addMonthsClamped, daysInMonth, startOfUtcDay } from "../../core/http/date.js";
import { AppError } from "../../core/http/errors.js";
import { getAccountBalance, getInvestmentValue } from "../accounts/accounts.service.js";
import { costOfLiving, getMonthlyTotals } from "../reports/reports.service.js";
import { computeLoanState } from "../reserve-loans/interest.js";
import { getReserveTargetMonths } from "../settings/settings.service.js";
import { getDebtOutstanding, isExpensiveDebt } from "./debt-outstanding.js";
import { NET_WORTH_MIN_PERCENT } from "./wealth-rules.js";

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
  const accounts = await prisma.account.findMany({
    where: { userId, isArchived: false, createdAt: { lt: addDays(today, 1) } },
    orderBy: { createdAt: "asc" },
  });
  const disponivel: WealthItem[] = [];
  const reserva: WealthItem[] = [];
  const investimentos: WealthItem[] = [];

  for (const account of accounts) {
    const details = { accountType: account.type };
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
        details,
      });
      continue;
    }
    if (account.type === "savings_reserve") {
      // The reserve earns (~100% do CDI): an informed balance anchors it like
      // an investment. Never informed, it's just the ledger — not flagged,
      // since many reserves are plain accounts.
      const { value, valuedAt } = await getInvestmentValue(userId, account.id, today);
      reserva.push({
        id: account.id,
        kind: "account",
        name: account.name,
        value: value.toFixed(2),
        source: valuedAt ? "informado" : "calculado",
        asOf: iso(valuedAt ?? today),
        stale: valuedAt != null && ageInDays(valuedAt, today) > STALE_DAYS.investment,
        note: valuedAt ? "Último saldo informado (com rendimento) + movimentações depois dele" : "Pelos lançamentos (sem rendimento)",
        details,
      });
      continue;
    }
    disponivel.push({
      id: account.id,
      kind: "account",
      name: account.name,
      value: (await getAccountBalance(userId, account.id, today)).toFixed(2),
      source: "calculado",
      asOf: iso(today),
      stale: false,
      note: "Pelos lançamentos",
      details,
    });
  }
  return { disponivel, reserva, investimentos };
}

type AssetWithValuations = Prisma.AssetGetPayload<{ include: { valuations: true } }>;

/**
 * What a bem was worth on `date`: its last informed value up to that day.
 * Null when it wasn't registered yet (neither created nor valued by then).
 */
export function getAssetValueAt(asset: AssetWithValuations, date: Date) {
  const valuations = [...asset.valuations].sort((a, b) => a.valuedAt.getTime() - b.valuedAt.getTime());
  const firstKnown = Math.min(startOfUtcDay(asset.createdAt).getTime(), valuations[0]?.valuedAt.getTime() ?? Infinity);
  if (date.getTime() < firstKnown) return null;
  const last = valuations.filter((v) => v.valuedAt.getTime() <= date.getTime()).at(-1) ?? valuations[0];
  return last
    ? { value: new Prisma.Decimal(last.value), valuedAt: last.valuedAt }
    : { value: new Prisma.Decimal(asset.value), valuedAt: asset.valuedAt };
}

async function informedAssetGroups(userId: string, today: Date, debtByAsset: Map<string, Prisma.Decimal>) {
  const all = await prisma.asset.findMany({ where: { userId }, include: { valuations: true }, orderBy: { createdAt: "asc" } });
  const aReceber: WealthItem[] = [];
  const bens: WealthItem[] = [];
  const rendaBens: WealthItem[] = [];
  const assets: { isLiquid: boolean; value: Prisma.Decimal }[] = [];
  for (const asset of all) {
    const at = getAssetValueAt(asset, today);
    if (!at) continue;
    assets.push({ isLiquid: asset.isLiquid, value: at.value });
    const isReceivable = asset.kind === "a_receber";
    const maxAge = isReceivable ? STALE_DAYS.a_receber : STALE_DAYS.bem;
    const debt = debtByAsset.get(asset.id) ?? null;
    const item: WealthItem = {
      id: asset.id,
      kind: "asset",
      name: asset.name,
      value: at.value.toFixed(2),
      source: "informado",
      asOf: iso(at.valuedAt),
      stale: ageInDays(at.valuedAt, today) > maxAge,
      note: isReceivable ? "Valor a receber informado" : "Valor de mercado informado",
      details: {
        assetKind: asset.kind,
        block: asset.block,
        isLiquid: asset.isLiquid,
        notes: asset.notes,
        // Financed bem: how much is still owed on it and how much is really yours.
        debtOutstanding: debt?.toFixed(2) ?? null,
        equity: debt ? at.value.minus(debt).toFixed(2) : null,
      },
    };
    if (isReceivable) aReceber.push(item);
    else if (asset.block === "investimentos") rendaBens.push(item);
    else bens.push(item);
  }
  return { aReceber, bens, rendaBens, assets };
}

// ------------------------------------------------------------- liabilities

async function debtGroups(userId: string, today: Date) {
  const all = await prisma.debt.findMany({ where: { userId, status: { not: "paga" } }, orderBy: { createdAt: "asc" } });
  // As of a past day, only debts already registered (or, for a financing, whose
  // first installment had already come) count.
  const debts = all.filter(
    (d) => Math.min(startOfUtcDay(d.createdAt).getTime(), d.firstInstallmentDate?.getTime() ?? Infinity) <= today.getTime()
  );
  const parcelaFixa: WealthItem[] = [];
  const saldoVariavel: WealthItem[] = [];
  const byAsset = new Map<string, Prisma.Decimal>();
  let monthlyInterest = ZERO;
  let expensiveDebt = ZERO;
  for (const debt of debts) {
    const outstanding = getDebtOutstanding(debt, today);
    if (debt.assetId) byAsset.set(debt.assetId, (byAsset.get(debt.assetId) ?? ZERO).plus(outstanding.value));
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
        assetId: debt.assetId,
      },
    };
    (outstanding.installmentsTotal != null ? parcelaFixa : saldoVariavel).push(item);
  }
  return { parcelaFixa, saldoVariavel, debts, byAsset, monthlyInterest, expensiveDebt };
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

export { NET_WORTH_MIN_PERCENT };

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
  const [{ disponivel, reserva, investimentos }, { parcelaFixa, saldoVariavel, byAsset, monthlyInterest, expensiveDebt }, cartao] =
    await Promise.all([accountGroups(userId, asOf), debtGroups(userId, asOf), cardGroup(userId, asOf)]);
  const { aReceber, bens, rendaBens, assets } = await informedAssetGroups(userId, asOf, byAsset);

  const assetGroups = [
    group("disponivel", "Disponível", disponivel),
    group("reserva", "Reserva", reserva),
    group("investimentos", "Investimentos", [...investimentos, ...rendaBens]),
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

/** A single item above this share of its bloco reads as concentrated. */
export const CONCENTRATION_PERCENT = 70;

/**
 * Método R8, informative only (never a product recommendation): reserve or
 * investments sitting mostly in one place, once the bloco is relevant (at
 * least a month of custo de vida).
 */
function concentration(groups: WealthGroup[], custoMensal: Prisma.Decimal | null) {
  if (!custoMensal || custoMensal.lessThanOrEqualTo(0)) return [];
  const result: { bloco: string; item: string; percent: string }[] = [];
  for (const g of groups) {
    if (g.group !== "reserva" && g.group !== "investimentos") continue;
    const total = new Prisma.Decimal(g.total);
    if (total.lessThan(custoMensal) || total.lessThanOrEqualTo(0)) continue;
    const top = g.items.reduce((a, b) => (new Prisma.Decimal(b.value).greaterThan(a.value) ? b : a));
    const share = new Prisma.Decimal(top.value).dividedBy(total).times(100);
    if (share.greaterThan(CONCENTRATION_PERCENT)) result.push({ bloco: g.group, item: top.name, percent: share.toFixed(0) });
  }
  return result;
}

const trendOf = (change: Prisma.Decimal | null) =>
  change == null
    ? null
    : change.abs().lessThan(STABLE_CHANGE_THRESHOLD)
      ? "estavel"
      : change.greaterThan(0)
        ? "crescendo"
        : "caindo";

/** How far back missing monthly snapshots are rebuilt. */
const MAX_BACKFILL_MONTHS = 24;

const snapshotFigures = (w: Awaited<ReturnType<typeof computeWealth>>) => ({
  assets: w.totalAssets,
  liabilities: w.totalLiabilities,
  netWorth: w.netWorth,
  financialNetWorth: w.financialNetWorth,
  cardCommitments: w.cardCommitments,
  netWorthPercent: snapshotPercent(w.netWorthPercent),
});

/**
 * Método R7: one closing figure per month. Every past month since the
 * user's first account (up to 24) that isn't final yet — missing, or last
 * written mid-month while it was the current one — is recomputed as of its
 * last day and frozen.
 */
async function finalizePastMonths(userId: string, today: Date) {
  const first = await prisma.account.findFirst({ where: { userId }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
  if (!first) return;
  const thisMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const firstMonth = new Date(Date.UTC(first.createdAt.getUTCFullYear(), first.createdAt.getUTCMonth(), 1));
  const oldest = addMonthsClamped(thisMonth, -MAX_BACKFILL_MONTHS);
  const final = await prisma.netWorthSnapshot.findMany({ where: { userId, isFinal: true }, select: { year: true, month: true } });
  const done = new Set(final.map((s) => s.year * 12 + s.month));

  for (let m = firstMonth > oldest ? firstMonth : oldest; m < thisMonth; m = addMonthsClamped(m, 1)) {
    const year = m.getUTCFullYear();
    const month = m.getUTCMonth() + 1;
    if (done.has(year * 12 + month)) continue;
    const lastDay = new Date(Date.UTC(year, month - 1, daysInMonth(year, month)));
    const figures = { ...snapshotFigures(await computeWealth(userId, lastDay)), isFinal: true };
    await prisma.netWorthSnapshot.upsert({
      where: { userId_year_month: { userId, year, month } },
      create: { userId, year, month, ...figures },
      update: figures,
    });
  }
}

export async function getWealth(userId: string, now = new Date()) {
  const today = startOfUtcDay(now);
  await finalizePastMonths(userId, today);
  const w = await computeWealth(userId, today);
  const [avgCost, reserveTargetMonths] = await Promise.all([averageMonthlyCost(userId, today), getReserveTargetMonths(userId)]);
  const reserveMonths = avgCost && avgCost.greaterThan(0) ? w.reserveTotal.dividedBy(avgCost) : null;
  // Método R3: falta = custo de vida × meses desejados − reserva atual.
  const reserveMissing = avgCost ? Prisma.Decimal.max(ZERO, avgCost.times(reserveTargetMonths).minus(w.reserveTotal)) : null;
  const reserveComplete = reserveMonths != null && !reserveMonths.lessThan(reserveTargetMonths);

  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() + 1;
  const figures = snapshotFigures(w);
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
      /** Blocos mostly in one account/bem (método R8) — information, not advice. */
      concentracao: concentration(w.assetGroups, avgCost),
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
  /** "investimentos" for a bem that produces income (imóvel alugado). */
  block?: "outros" | "investimentos";
  notes?: string;
}

export function listAssets(userId: string) {
  return prisma.asset.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
}

export function createAsset(userId: string, input: AssetInput) {
  return prisma.asset.create({
    data: {
      userId,
      ...input,
      isLiquid: input.isLiquid ?? input.kind === "a_receber",
      valuations: { create: { valuedAt: input.valuedAt, value: input.value } },
    },
  });
}

async function getOwnedAsset(userId: string, id: string) {
  const asset = await prisma.asset.findUnique({ where: { id } });
  if (!asset || asset.userId !== userId) throw AppError.notFound("Asset not found");
  return asset;
}

/**
 * A new value is also kept in the bem's history (one per day), so past
 * months keep the value they had — revaluing a car down shows up as the
 * patrimônio falling in the month it happened. Asset.value always mirrors
 * the latest valuation.
 */
export async function updateAsset(userId: string, id: string, input: Partial<AssetInput>) {
  await getOwnedAsset(userId, id);
  return prisma.$transaction(async (tx) => {
    if (input.value != null && input.valuedAt) {
      await tx.assetValuation.upsert({
        where: { assetId_valuedAt: { assetId: id, valuedAt: input.valuedAt } },
        create: { assetId: id, valuedAt: input.valuedAt, value: input.value },
        update: { value: input.value },
      });
    }
    const { value: _value, valuedAt: _valuedAt, ...rest } = input;
    const latest = await tx.assetValuation.findFirst({ where: { assetId: id }, orderBy: { valuedAt: "desc" } });
    return tx.asset.update({
      where: { id },
      data: { ...rest, ...(latest ? { value: latest.value, valuedAt: latest.valuedAt } : {}) },
    });
  });
}

export async function deleteAsset(userId: string, id: string) {
  await getOwnedAsset(userId, id);
  await prisma.asset.delete({ where: { id } });
}
