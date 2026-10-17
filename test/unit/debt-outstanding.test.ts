import { Prisma, type Debt } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { getDebtOutstanding, installmentDueDate } from "../../src/modules/wealth/debt-outstanding.js";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

function debt(overrides: Partial<Debt>): Debt {
  return {
    id: "d",
    userId: "u",
    creditor: "Banco",
    type: "consignado",
    status: "em_dia",
    originalAmount: null,
    currentBalance: new Prisma.Decimal(0),
    installmentAmount: null,
    installmentDueDay: null,
    installmentsTotal: null,
    installmentsPaid: 0,
    kind: "saldo_variavel",
    firstInstallmentDate: null,
    payoffAmount: null,
    payoffAmountAt: null,
    balanceUpdatedAt: null,
    monthlyInterestRate: null,
    notes: null,
    createdAt: utc(2025, 1, 1),
    updatedAt: utc(2025, 1, 1),
    ...overrides,
  };
}

const consignado = (overrides: Partial<Debt> = {}) =>
  debt({
    kind: "parcela_fixa",
    installmentAmount: new Prisma.Decimal("450.00"),
    installmentsTotal: 48,
    installmentDueDay: 10,
    firstInstallmentDate: utc(2025, 10, 10),
    ...overrides,
  });

describe("installmentDueDate", () => {
  it("keeps the due day every month, clamped to short months", () => {
    const first = utc(2025, 11, 28);
    expect(installmentDueDate(first, 31, 0)).toEqual(utc(2025, 11, 30));
    expect(installmentDueDate(first, 31, 2)).toEqual(utc(2026, 1, 31));
    expect(installmentDueDate(first, 31, 3)).toEqual(utc(2026, 2, 28));
    expect(installmentDueDate(first, 31, 4)).toEqual(utc(2026, 3, 31));
  });
});

describe("getDebtOutstanding — parcela fixa", () => {
  it("counts installments as paid as their due dates pass, with no payments registered", () => {
    // #1 2025-10-10 … #13 2026-10-10. On 2026-10-17, 13 have passed.
    const result = getDebtOutstanding(consignado(), utc(2026, 10, 17));
    expect(result.installmentsPaid).toBe(13);
    expect(result.value.toFixed(2)).toBe("15750.00"); // 35 × 450
    expect(result.source).toBe("calculado");
    expect(result.nextDueDate).toEqual(utc(2026, 11, 10));
    expect(result.endDate).toEqual(utc(2029, 9, 10));
  });

  it("an installment due today is still to pay", () => {
    const result = getDebtOutstanding(consignado(), utc(2026, 10, 10));
    expect(result.installmentsPaid).toBe(12);
    expect(result.nextDueDate).toEqual(utc(2026, 10, 10));
  });

  it("reaches zero after the last installment", () => {
    const result = getDebtOutstanding(consignado(), utc(2029, 9, 11));
    expect(result.installmentsPaid).toBe(48);
    expect(result.value.toFixed(2)).toBe("0.00");
    expect(result.nextDueDate).toBeNull();
  });

  it("prefers a recent 'valor para quitar' and ignores an old one", () => {
    const withPayoff = consignado({ payoffAmount: new Prisma.Decimal("12000.00"), payoffAmountAt: utc(2026, 9, 1) });

    const recent = getDebtOutstanding(withPayoff, utc(2026, 10, 17));
    expect(recent.value.toFixed(2)).toBe("12000.00");
    expect(recent.source).toBe("informado");
    expect(recent.remainingInstallmentsSum?.toFixed(2)).toBe("15750.00");

    const old = getDebtOutstanding(withPayoff, utc(2027, 1, 5));
    expect(old.source).toBe("calculado");
  });

  it("estimates the monthly interest cost when a rate is known", () => {
    const result = getDebtOutstanding(
      consignado({ monthlyInterestRate: new Prisma.Decimal("1.8") }),
      utc(2026, 10, 17)
    );
    expect(result.monthlyInterestCost?.toFixed(2)).toBe("283.50");
  });
});

describe("getDebtOutstanding — saldo variável", () => {
  it("uses the informed balance and flags it after 30 days", () => {
    const rotativo = debt({
      type: "cartao_vencido",
      currentBalance: new Prisma.Decimal("2500.00"),
      balanceUpdatedAt: utc(2026, 9, 1),
    });
    const fresh = getDebtOutstanding(rotativo, utc(2026, 9, 20));
    expect(fresh.value.toFixed(2)).toBe("2500.00");
    expect(fresh.stale).toBe(false);
    expect(getDebtOutstanding(rotativo, utc(2026, 10, 17)).stale).toBe(true);
  });

  it("a debt marked as paid weighs nothing", () => {
    const result = getDebtOutstanding(debt({ status: "paga", currentBalance: new Prisma.Decimal("900") }), utc(2026, 10, 17));
    expect(result.value.toFixed(2)).toBe("0.00");
  });
});
