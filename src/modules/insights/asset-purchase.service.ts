import { Prisma } from "@prisma/client";
import { prisma } from "../../core/db/prisma.js";
import { addMonthsClamped, startOfUtcDay } from "../../core/http/date.js";
import { AppError } from "../../core/http/errors.js";
import { getOwnedAccount } from "../accounts/accounts.service.js";
import { createRecurringTransaction } from "../recurring-transactions/recurring-transactions.service.js";
import { getReserveTargetMonths } from "../settings/settings.service.js";
import { installmentDueDate } from "../wealth/debt-outstanding.js";
import { averageMonthlyCost, computeWealth } from "../wealth/wealth.service.js";
import { overlayAssetPurchase, totalCost, type AssetPurchaseOverlay, type Side, type WealthPicture } from "./asset-purchase.js";
import { MAX_SIMULATED_MONTHS, loadBaseline } from "./purchase-baseline.js";
import { evaluateCashOuts, isPertinent, monthIndexOf, type CashOut, type Verdict } from "./purchase-impact.js";

const ZERO = new Prisma.Decimal(0);

export interface AssetPurchaseRequest {
  description?: string;
  assetKind: "imovel" | "veiculo" | "outro";
  /** Imóvel alugado etc.: lands in Investimentos instead of Bens. */
  producesIncome?: boolean;
  price: string;
  /** ITBI, IPVA, impostos. */
  taxes?: string;
  /** Escritura, registro, documentação, despachante. */
  fees?: string;
  /** Defaults to the whole cost when there's no financing. */
  downPayment?: string;
  downPaymentAccountId: string;
  financing?: {
    installments: number;
    installmentAmount: string;
    /** Defaults to the same day next month. */
    firstDueDate?: Date;
    /** Saldo devedor right after buying (e.g. 256k). Without it, the sum of the installments (which includes future interest). */
    principal?: string;
    /** Where the installments are paid from (default: the first conta corrente). */
    installmentAccountId?: string;
  };
}

const money = (d: Prisma.Decimal) => d.toFixed(2);
const brl = (d: Prisma.Decimal) =>
  `R$ ${d
    .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
    .toNumber()
    .toLocaleString("pt-BR")}`;
const pct = (d: Prisma.Decimal | null) => (d == null ? "—" : `${d.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toString()}%`);
const months = (d: Prisma.Decimal | null) => (d == null ? "?" : d.toDecimalPlaces(1).toString().replace(".", ","));

interface Resolved {
  price: Prisma.Decimal;
  taxes: Prisma.Decimal;
  fees: Prisma.Decimal;
  cost: Prisma.Decimal;
  downPayment: Prisma.Decimal;
  financed: Prisma.Decimal;
  financedIsSum: boolean;
  firstDueDate: Date | null;
  installmentAccountId: string | null;
}

async function resolve(userId: string, req: AssetPurchaseRequest, today: Date): Promise<Resolved> {
  const dec = (v: string | undefined, field: string) => {
    if (v == null) return ZERO;
    if (!/^\d+(\.\d{1,2})?$/.test(v)) throw AppError.badRequest(`${field} must be a non-negative amount like 1234.56`);
    return new Prisma.Decimal(v);
  };
  const price = dec(req.price, "price");
  if (price.isZero()) throw AppError.badRequest("price must be greater than zero");
  const taxes = dec(req.taxes, "taxes");
  const fees = dec(req.fees, "fees");
  const cost = totalCost({ price, taxes, fees });
  await getOwnedAccount(userId, req.downPaymentAccountId);

  const f = req.financing;
  const downPayment = req.downPayment != null ? dec(req.downPayment, "downPayment") : f ? ZERO : cost;
  if (downPayment.greaterThan(cost)) throw AppError.badRequest("downPayment cannot exceed the total cost");
  if (!f && downPayment.lessThan(cost)) {
    throw AppError.badRequest("without financing, the downPayment must cover the total cost (preço + impostos + documentação)");
  }

  let financed = ZERO;
  let financedIsSum = false;
  let firstDueDate: Date | null = null;
  let installmentAccountId: string | null = null;
  if (f) {
    const installment = dec(f.installmentAmount, "installmentAmount");
    if (installment.isZero()) throw AppError.badRequest("installmentAmount must be greater than zero");
    financedIsSum = f.principal == null;
    financed = f.principal != null ? dec(f.principal, "principal") : installment.times(f.installments);
    firstDueDate = f.firstDueDate ?? addMonthsClamped(today, 1);
    if (f.installmentAccountId) {
      await getOwnedAccount(userId, f.installmentAccountId);
      installmentAccountId = f.installmentAccountId;
    } else {
      const checking = await prisma.account.findFirst({
        where: { userId, type: "checking", isArchived: false },
        orderBy: { createdAt: "asc" },
      });
      installmentAccountId = checking?.id ?? null;
    }
  }
  return { price, taxes, fees, cost, downPayment, financed, financedIsSum, firstDueDate, installmentAccountId };
}

function pictureOf(w: Awaited<ReturnType<typeof computeWealth>>): WealthPicture {
  const groups: Record<string, Prisma.Decimal> = {};
  const groupOfAccount: Record<string, string> = {};
  for (const g of w.assetGroups) {
    groups[g.group] = new Prisma.Decimal(g.total);
    for (const i of g.items) if (i.kind === "account") groupOfAccount[i.id] = g.group;
  }
  return {
    groups,
    groupOfAccount,
    totalLiabilities: w.totalLiabilities,
    financialNetWorth: w.financialNetWorth,
    reserveTotal: w.reserveTotal,
  };
}

const SEVERITY: Record<Verdict, number> = { cabe: 0, aperta: 1, fura_reserva: 2, nao_cabe: 3 };

/**
 * "Compra de bem" (método R5): the real cost, how it's paid, and what it
 * does to the patrimônio (total, líquido, % líquido, reserve, division
 * between blocks) — plus the same cash-flow check as "E se?" for the entrada
 * and the installments. Nothing is saved.
 */
export async function simulateAssetPurchase(userId: string, req: AssetPurchaseRequest) {
  const today = startOfUtcDay(new Date());
  const r = await resolve(userId, req, today);
  const [w, custoMensal, metaMeses] = await Promise.all([
    computeWealth(userId, today),
    averageMonthlyCost(userId, today),
    getReserveTargetMonths(userId),
  ]);
  const overlay = overlayAssetPurchase(
    pictureOf(w),
    {
      price: r.price,
      taxes: r.taxes,
      fees: r.fees,
      downPayment: r.downPayment,
      downPaymentAccountId: req.downPaymentAccountId,
      assetGroup: req.producesIncome ? "investimentos" : "bens",
      financed: r.financed,
    },
    custoMensal
  );

  // Cash flow on the checking pool (Saldos): the entrada if it leaves a conta
  // corrente, and the installments paid from one.
  const accounts = await prisma.account.findMany({ where: { userId }, select: { id: true, type: true } });
  const isChecking = (id: string | null) => id != null && accounts.find((a) => a.id === id)?.type === "checking";
  const cashOuts: CashOut[] = [];
  if (r.downPayment.greaterThan(0) && isChecking(req.downPaymentAccountId)) cashOuts.push({ date: today, amount: r.downPayment });
  const f = req.financing;
  if (f && r.firstDueDate && isChecking(r.installmentAccountId)) {
    const dueDay = r.firstDueDate.getUTCDate();
    for (let i = 0; i < Math.min(f.installments, MAX_SIMULATED_MONTHS); i++) {
      cashOuts.push({ date: installmentDueDate(r.firstDueDate, dueDay, i), amount: new Prisma.Decimal(f.installmentAmount) });
    }
  }
  const fromIndex = monthIndexOf(today);
  const lastIndex = Math.max(fromIndex, ...cashOuts.map((c) => monthIndexOf(c.date)));
  const loaded = await loadBaseline(userId, fromIndex, lastIndex);
  const biggest = cashOuts.reduce((m, c) => (c.amount.greaterThan(m) ? c.amount : m), ZERO);
  const impact = cashOuts.length
    ? evaluateCashOuts(loaded.baseline, cashOuts, { fromDate: today, pertinent: isPertinent(loaded.baseline, biggest) })
    : null;

  const reserveBelowTarget = overlay.depois.reservaMeses != null && overlay.depois.reservaMeses.lessThan(metaMeses);
  const reserveHit = overlay.origemDaEntrada === "reserva" && r.downPayment.greaterThan(0);
  let verdict: Verdict = impact?.verdict ?? "cabe";
  // Paying the entrada out of the reserve and leaving it under the target is
  // exactly what the reserve guardian exists for.
  if (reserveHit && reserveBelowTarget && SEVERITY[verdict] < SEVERITY.fura_reserva) verdict = "fura_reserva";

  const linhas = textLines(req, r, overlay, { metaMeses, reserveHit, verdict, impact });
  return {
    descricao: req.description ?? null,
    veredito: verdict,
    manchete: headline(verdict, req.description),
    linhas,
    custo: { preco: money(r.price), impostos: money(r.taxes), documentacao: money(r.fees), total: money(r.cost) },
    pagamento: {
      entrada: money(r.downPayment),
      origemDaEntrada: overlay.origemDaEntrada,
      financiado: money(r.financed),
      financiadoPelaSomaDasParcelas: r.financedIsSum,
      parcela: f ? money(new Prisma.Decimal(f.installmentAmount)) : null,
      parcelas: f?.installments ?? null,
      primeiroVencimento: r.firstDueDate?.toISOString().slice(0, 10) ?? null,
    },
    antes: sideJson(overlay.antes),
    depois: sideJson(overlay.depois),
    reserva: { metaMeses, ficaAbaixoDaMeta: reserveBelowTarget, entradaSaiDaReserva: reserveHit },
    fluxo: impact
      ? {
          veredito: impact.verdict,
          menorSaldoDepois: impact.lowestAfter
            ? { data: impact.lowestAfter.date, valor: money(impact.lowestAfter.value) }
            : null,
        }
      : null,
  };
}

function sideJson(s: Side) {
  const blocos = Object.fromEntries(
    Object.entries(s.blocos).map(([k, v]) => [k, { valor: money(v.valor), percent: v.percent?.toFixed(1) ?? null }])
  );
  return {
    total: money(s.total),
    saldoDevedor: money(s.saldoDevedor),
    liquido: money(s.liquido),
    percentLiquido: s.percentLiquido?.toFixed(1) ?? null,
    alertaAbaixoDe40: s.alerta,
    livreEmDinheiro: money(s.livreEmDinheiro),
    reserva: money(s.reserva),
    reservaMeses: s.reservaMeses?.toFixed(1) ?? null,
    blocos,
  };
}

function headline(verdict: Verdict, description?: string) {
  const what = description?.trim() || "Essa compra";
  switch (verdict) {
    case "cabe":
      return `${what} cabe no seu planejamento.`;
    case "aperta":
      return `${what} cabe, mas aperta.`;
    case "fura_reserva":
      return `${what} fura a sua reserva.`;
    case "nao_cabe":
      return `${what} não cabe agora.`;
  }
}

function textLines(
  req: AssetPurchaseRequest,
  r: Resolved,
  o: AssetPurchaseOverlay,
  ctx: { metaMeses: number; reserveHit: boolean; verdict: Verdict; impact: ReturnType<typeof evaluateCashOuts> | null }
) {
  const lines: string[] = [];
  const extras = r.taxes.plus(r.fees);
  lines.push(
    extras.greaterThan(0)
      ? `Custo real: ${brl(r.cost)} (${brl(r.price)} + ${brl(extras)} de impostos e documentação). O bem entra no patrimônio por esse valor.`
      : `Custo real: ${brl(r.cost)}. Lembre de somar impostos e documentação — eles fazem parte do valor do bem.`
  );
  lines.push(
    `Patrimônio total: ${brl(o.antes.total)} → ${brl(o.depois.total)}. Líquido: ${brl(o.antes.liquido)} → ${brl(o.depois.liquido)}.`
  );
  lines.push(
    `Percentual líquido: ${pct(o.antes.percentLiquido)} → ${pct(o.depois.percentLiquido)}` +
      (o.depois.alerta ? " — abaixo de 40%: evite novas dívidas até ele voltar a subir." : ".")
  );
  if (ctx.reserveHit) {
    lines.push(
      `A entrada sai da reserva: ela vai de ${months(o.antes.reservaMeses)} para ${months(o.depois.reservaMeses)} meses (sua meta: ${ctx.metaMeses}).`
    );
  } else if (o.depois.reservaMeses != null) {
    lines.push(`A reserva continua em ${months(o.depois.reservaMeses)} meses (sua meta: ${ctx.metaMeses}).`);
  }
  const b = (s: Side) =>
    `reserva ${pct(s.blocos.reserva.percent)}, investimentos ${pct(s.blocos.investimentos.percent)}, outros ${pct(s.blocos.outros.percent)}`;
  lines.push(`Divisão: ${b(o.antes)} → ${b(o.depois)}.`);
  if (req.financing) {
    const parcela = brl(new Prisma.Decimal(req.financing.installmentAmount));
    const fluxo =
      ctx.impact?.verdict === "nao_cabe"
        ? "o saldo fica negativo em algum mês"
        : ctx.impact?.verdict === "fura_reserva"
          ? "você passa a guardar menos que a meta"
          : ctx.impact?.verdict === "aperta"
            ? "o saldo fica apertado"
            : "o saldo aguenta";
    lines.push(`Parcela de ${parcela} por ${req.financing.installments} meses: ${fluxo}.`);
    if (r.financedIsSum) {
      lines.push("Sem o saldo devedor do contrato, usei a soma das parcelas (inclui juros futuros) — informe o valor financiado para ficar exato.");
    }
  }
  if (req.assetKind === "veiculo") {
    lines.push("Carro desvaloriza todo ano: atualize o valor dele — ele puxa a linha do patrimônio para baixo. Prefira o que valoriza.");
  }
  return lines;
}

/**
 * Registers the purchase as the método says: the bem at its total cost, the
 * entrada as a saída tied to it (never custo de vida), the financing as a
 * fixed-installment debt linked to the bem, and its installments as a monthly
 * saída from the paying account (so Saldos and "dá para guardar" see them).
 */
export async function registerAssetPurchase(userId: string, req: AssetPurchaseRequest & { name: string }) {
  const today = startOfUtcDay(new Date());
  const r = await resolve(userId, req, today);
  const label = req.name.trim();
  if (!label) throw AppError.badRequest("name is required");

  const { asset, debt } = await prisma.$transaction(async (tx) => {
    const asset = await tx.asset.create({
      data: {
        userId,
        name: label,
        kind: req.assetKind,
        block: req.producesIncome ? "investimentos" : "outros",
        value: r.cost,
        valuedAt: today,
        notes: `Preço ${money(r.price)} + impostos ${money(r.taxes)} + documentação ${money(r.fees)}`,
        valuations: { create: { valuedAt: today, value: r.cost } },
      },
    });
    if (r.downPayment.greaterThan(0)) {
      await tx.transaction.create({
        data: {
          userId,
          accountId: req.downPaymentAccountId,
          type: "saida",
          amount: r.downPayment,
          date: today,
          description: `Entrada: ${label}`,
          assetId: asset.id,
        },
      });
    }
    const f = req.financing;
    const debt =
      f && r.firstDueDate
        ? await tx.debt.create({
            data: {
              userId,
              creditor: `Financiamento: ${label}`,
              type: "financiamento",
              kind: "parcela_fixa",
              originalAmount: r.financed,
              currentBalance: "0",
              installmentAmount: f.installmentAmount,
              installmentsTotal: f.installments,
              installmentDueDay: r.firstDueDate.getUTCDate(),
              firstInstallmentDate: r.firstDueDate,
              payoffAmount: r.financedIsSum ? null : r.financed,
              payoffAmountAt: r.financedIsSum ? null : today,
              balanceUpdatedAt: today,
              assetId: asset.id,
            },
          })
        : null;
    return { asset, debt };
  });

  const f = req.financing;
  const series =
    f && r.firstDueDate && r.installmentAccountId
      ? await createRecurringTransaction(userId, {
          accountId: r.installmentAccountId,
          type: "saida",
          amount: f.installmentAmount,
          startDate: r.firstDueDate,
          interval: "monthly",
          occurrenceCount: f.installments,
          description: `Parcela: ${label}`,
        })
      : null;

  return { assetId: asset.id, debtId: debt?.id ?? null, recurringTransactionId: series?.id ?? null };
}
