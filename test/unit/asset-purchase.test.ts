import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { overlayAssetPurchase, totalCost, type WealthPicture } from "../../src/modules/insights/asset-purchase.js";

const D = (v: string | number) => new Prisma.Decimal(v);

// 20k na corrente, 60k na reserva, 100k investidos, nenhuma dívida.
const before: WealthPicture = {
  groups: { disponivel: D(20000), reserva: D(60000), investimentos: D(100000) },
  groupOfAccount: { "acc-checking": "disponivel", "acc-reserve": "reserva", "acc-inv": "investimentos" },
  totalLiabilities: D(0),
  financialNetWorth: D(180000),
  reserveTotal: D(60000),
};

const apartment = {
  price: D(320000),
  taxes: D(15000),
  fees: D(5000),
  downPayment: D(84000),
  assetGroup: "bens" as const,
  financed: D(256000),
};

describe("compra de bem (método R5)", () => {
  it("counts taxes and documentation as part of the bem's value", () => {
    expect(totalCost(apartment).toString()).toBe("340000");
  });

  it("total rises, % líquido falls, the bem enters at total cost and the financing becomes saldo devedor", () => {
    const o = overlayAssetPurchase(before, { ...apartment, downPaymentAccountId: "acc-inv" }, D(5000));

    expect(o.antes.total.toString()).toBe("180000");
    expect(o.antes.percentLiquido!.toString()).toBe("100");
    expect(o.depois.total.toString()).toBe("436000"); // 180k − 84k + 340k
    expect(o.depois.saldoDevedor.toString()).toBe("256000");
    expect(o.depois.liquido.toString()).toBe("180000");
    expect(o.depois.percentLiquido!.toFixed(1)).toBe("41.3");
    expect(o.depois.alerta).toBe(false);
    // The money that's actually free drops by the entrada and the new debt.
    expect(o.depois.livreEmDinheiro.toString()).toBe("-160000");
    // Division between the método's blocks.
    expect(o.depois.blocos.investimentos.valor.toString()).toBe("16000");
    expect(o.depois.blocos.outros.valor.toString()).toBe("360000"); // 20k corrente + 340k imóvel
    expect(o.depois.reservaMeses!.toString()).toBe("12"); // untouched
  });

  it("an entrada paid from the reserve shrinks it", () => {
    const o = overlayAssetPurchase(
      before,
      { ...apartment, downPayment: D(40000), financed: D(300000), downPaymentAccountId: "acc-reserve" },
      D(5000)
    );
    expect(o.origemDaEntrada).toBe("reserva");
    expect(o.antes.reservaMeses!.toString()).toBe("12");
    expect(o.depois.reserva.toString()).toBe("20000");
    expect(o.depois.reservaMeses!.toString()).toBe("4");
    expect(o.depois.alerta).toBe(true); // 180k líquido of 480k total
  });

  it("a bem that produces income goes to the investimentos bloco", () => {
    const o = overlayAssetPurchase(
      before,
      { ...apartment, assetGroup: "investimentos", downPaymentAccountId: "acc-inv" },
      null
    );
    expect(o.depois.blocos.investimentos.valor.toString()).toBe("356000");
    expect(o.depois.reservaMeses).toBeNull();
  });
});
