import { Prisma } from "@prisma/client";
import { NET_WORTH_MIN_PERCENT } from "../wealth/wealth-rules.js";

/**
 * Pure part of "Compra de bem" (método R5): overlays buying a bem — an
 * imóvel, a carro — on today's patrimônio. No database access, so the rules
 * are unit-testable:
 *
 * 1. Quanto custa de verdade: preço + impostos + documentação. The bem
 *    enters the patrimônio at that total cost (340k, not 320k).
 * 2. Como paga: an entrada from one account (corrente, reserva or
 *    investimento) and, optionally, a financing whose saldo devedor becomes
 *    a debt.
 * 3. Impacto: patrimônio total rises, líquido falls (by the costs that don't
 *    come back), the % líquido moves, the reserve may shrink, and the
 *    division between the método's blocks changes.
 */

const ZERO = new Prisma.Decimal(0);

/** The método's three blocks, plus what doesn't fit them. */
export type Bloco = "reserva" | "investimentos" | "outros";

export interface WealthPicture {
  /** Asset group key (disponivel, reserva, investimentos, a_receber, bens) → total. */
  groups: Record<string, Prisma.Decimal>;
  /** Asset group key that holds each account id. */
  groupOfAccount: Record<string, string>;
  totalLiabilities: Prisma.Decimal;
  financialNetWorth: Prisma.Decimal;
  reserveTotal: Prisma.Decimal;
}

export interface AssetPurchaseInput {
  price: Prisma.Decimal;
  taxes: Prisma.Decimal;
  fees: Prisma.Decimal;
  downPayment: Prisma.Decimal;
  downPaymentAccountId: string;
  /** Group the bem lands in: "bens", or "investimentos" for one that produces income. */
  assetGroup: "bens" | "investimentos";
  /** Saldo devedor of the financing (0 without one). */
  financed: Prisma.Decimal;
}

export interface Side {
  total: Prisma.Decimal;
  saldoDevedor: Prisma.Decimal;
  liquido: Prisma.Decimal;
  percentLiquido: Prisma.Decimal | null;
  alerta: boolean;
  livreEmDinheiro: Prisma.Decimal;
  reserva: Prisma.Decimal;
  reservaMeses: Prisma.Decimal | null;
  blocos: Record<Bloco, { valor: Prisma.Decimal; percent: Prisma.Decimal | null }>;
}

const blocoOf = (group: string): Bloco => (group === "reserva" ? "reserva" : group === "investimentos" ? "investimentos" : "outros");

function side(
  groups: Record<string, Prisma.Decimal>,
  saldoDevedor: Prisma.Decimal,
  livre: Prisma.Decimal,
  reserva: Prisma.Decimal,
  custoMensal: Prisma.Decimal | null
): Side {
  const total = Object.values(groups).reduce((s, v) => s.plus(v), ZERO);
  const liquido = total.minus(saldoDevedor);
  const percentLiquido = total.greaterThan(0) ? liquido.dividedBy(total).times(100) : null;
  const blocos: Side["blocos"] = {
    reserva: { valor: ZERO, percent: null },
    investimentos: { valor: ZERO, percent: null },
    outros: { valor: ZERO, percent: null },
  };
  for (const [group, value] of Object.entries(groups)) blocos[blocoOf(group)].valor = blocos[blocoOf(group)].valor.plus(value);
  for (const b of Object.values(blocos)) b.percent = total.greaterThan(0) ? b.valor.dividedBy(total).times(100) : null;
  return {
    total,
    saldoDevedor,
    liquido,
    percentLiquido,
    alerta: percentLiquido != null && percentLiquido.lessThan(NET_WORTH_MIN_PERCENT),
    livreEmDinheiro: livre,
    reserva,
    reservaMeses: custoMensal && custoMensal.greaterThan(0) ? reserva.dividedBy(custoMensal) : null,
    blocos,
  };
}

export function totalCost(input: Pick<AssetPurchaseInput, "price" | "taxes" | "fees">) {
  return input.price.plus(input.taxes).plus(input.fees);
}

/**
 * Before/after the purchase. The entrada leaves its account's group; the bem
 * enters at its total cost; the financing adds to the saldo devedor. The
 * free money drops by the entrada and by the new debt (a bem doesn't pay
 * bills), so líquido − livre is exactly the bem's value.
 */
export function overlayAssetPurchase(before: WealthPicture, input: AssetPurchaseInput, custoMensal: Prisma.Decimal | null) {
  const cost = totalCost(input);
  const sourceGroup = before.groupOfAccount[input.downPaymentAccountId] ?? "disponivel";
  const after: Record<string, Prisma.Decimal> = { ...before.groups };
  after[sourceGroup] = (after[sourceGroup] ?? ZERO).minus(input.downPayment);
  after[input.assetGroup] = (after[input.assetGroup] ?? ZERO).plus(cost);
  const reserveAfter = sourceGroup === "reserva" ? before.reserveTotal.minus(input.downPayment) : before.reserveTotal;

  return {
    custoTotal: cost,
    origemDaEntrada: sourceGroup,
    antes: side(before.groups, before.totalLiabilities, before.financialNetWorth, before.reserveTotal, custoMensal),
    depois: side(
      after,
      before.totalLiabilities.plus(input.financed),
      before.financialNetWorth.minus(input.downPayment).minus(input.financed),
      reserveAfter,
      custoMensal
    ),
  };
}

export type AssetPurchaseOverlay = ReturnType<typeof overlayAssetPurchase>;
