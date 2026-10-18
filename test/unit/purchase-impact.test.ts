import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { Baseline, BaselineMonth } from "../../src/modules/insights/purchase-impact.js";
import { evaluateCashOuts, isPertinent, purchasePlan, saveUpPlan } from "../../src/modules/insights/purchase-impact.js";

const D = (v: string | number) => new Prisma.Decimal(v);
const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/**
 * A 30-day month with a flat saldo, starting at `index` (2030-01 = 2030*12).
 * entradas 10.000, meta 20% = 2.000, sobra 5.000, nothing saved yet,
 * folga 700 (a week of R$ 100/day), so "dá para guardar" = 5.000.
 */
function month(year: number, m: number, overrides: Partial<BaselineMonth> & { saldo?: number } = {}): BaselineMonth {
  const mes = `${year}-${String(m).padStart(2, "0")}`;
  const days = Array.from({ length: 28 }, (_, i) => {
    const date = `${mes}-${String(i + 1).padStart(2, "0")}`;
    return { date, time: utc(date).getTime(), saldo: D(overrides.saldo ?? 8000) };
  });
  return {
    index: year * 12 + m - 1,
    mes,
    isPast: false,
    days,
    entradas: D(10000),
    economiaFeita: D(0),
    sobraProjetada: D(5000),
    folga: D(700),
    totalPossivel: D(5000),
    metaValor: D(2000),
    ...overrides,
  };
}

function baseline(months: BaselineMonth[], strict = true): Baseline {
  return { today: utc(`${months[0].mes}-01`), months, metaPercent: D(20), strict };
}

describe("purchase impact (E se?)", () => {
  it("fits when saldo and savings stay above the folga and the target", () => {
    const b = baseline([month(2030, 1)]);
    const impact = evaluateCashOuts(b, [{ date: utc("2030-01-10"), amount: D(1000) }], { fromDate: utc("2030-01-01"), pertinent: true });
    expect(impact.verdict).toBe("cabe");
    expect(impact.months[0].guardaDepois.toFixed(2)).toBe("4000.00");
    expect(impact.lowestAfter?.value.toFixed(2)).toBe("7000.00");
  });

  it("fura a reserva: a pertinent purchase that pushes savings under the target", () => {
    const b = baseline([month(2030, 1)]);
    // sobra 5.000 − 3.500 = 1.500 < meta 2.000; saldo still 4.500 (> folga).
    const impact = evaluateCashOuts(b, [{ date: utc("2030-01-10"), amount: D(3500) }], { fromDate: utc("2030-01-01"), pertinent: true });
    expect(impact.verdict).toBe("fura_reserva");
    expect(impact.months[0].furaMeta).toBe(true);
  });

  it("with the reserve complete, the same purchase is only 'aperta'", () => {
    const b = baseline([month(2030, 1)], false);
    const impact = evaluateCashOuts(b, [{ date: utc("2030-01-10"), amount: D(3500) }], { fromDate: utc("2030-01-01"), pertinent: true });
    expect(impact.verdict).toBe("aperta");
  });

  it("small purchases (not pertinent) don't trigger the guardian", () => {
    const b = baseline([month(2030, 1, { sobraProjetada: D(2100), totalPossivel: D(2100) })]);
    expect(isPertinent(b, D(500))).toBe(false); // < 10% of 10.000
    expect(isPertinent(b, D(1000))).toBe(true);
    const impact = evaluateCashOuts(b, [{ date: utc("2030-01-10"), amount: D(500) }], { fromDate: utc("2030-01-01"), pertinent: false });
    expect(impact.months[0].furaMeta).toBe(true);
    expect(impact.verdict).toBe("cabe");
  });

  it("aperta when the saldo dips under a week of diário", () => {
    const b = baseline([month(2030, 1, { saldo: 1000 })]);
    const impact = evaluateCashOuts(b, [{ date: utc("2030-01-10"), amount: D(400) }], { fromDate: utc("2030-01-01"), pertinent: false });
    expect(impact.verdict).toBe("aperta");
  });

  it("não cabe when the saldo goes negative, flagging months already negative", () => {
    const b = baseline([month(2030, 1, { saldo: 1000 }), month(2030, 2, { saldo: -50 })]);
    const impact = evaluateCashOuts(b, [{ date: utc("2030-01-10"), amount: D(2000) }], {
      fromDate: utc("2030-01-01"),
      pertinent: true,
      untilIndex: 2030 * 12 + 1,
    });
    expect(impact.verdict).toBe("nao_cabe");
    expect(impact.months.map((m) => [m.ficaNegativoComACompra, m.jaNegativoSemACompra])).toEqual([
      [true, false],
      [true, true],
    ]);
  });

  it("installments weigh only on the month each one is due", () => {
    const b = baseline([month(2030, 1), month(2030, 2), month(2030, 3)]);
    const impact = evaluateCashOuts(
      b,
      [
        { date: utc("2030-02-08"), amount: D(1500) },
        { date: utc("2030-03-08"), amount: D(1500) },
      ],
      { fromDate: utc("2030-01-15"), pertinent: true }
    );
    expect(impact.months.map((m) => m.pagaNoMes.toFixed(0))).toEqual(["0", "1500", "1500"]);
    expect(impact.verdict).toBe("cabe");
  });

  it("junte para ela: accumulates what's left above the target", () => {
    // 3.000 above the target each month → R$ 7.000 takes 3 months.
    const b = baseline([month(2030, 1), month(2030, 2), month(2030, 3), month(2030, 4)]);
    expect(saveUpPlan(b, D(7000))).toEqual({ mes: "2030-03", meses: 3, porMes: D("2333.34") });
    const noMargin = baseline([month(2030, 1, { totalPossivel: D(1000) })]);
    expect(saveUpPlan(noMargin, D(100))).toBeNull();
  });

  it("plan: hole this month, monthly cut from the typical month, the purchase minus the margin", () => {
    // October already negative on the 25th; the next months spend 1.500 more than comes in.
    const oct = month(2030, 10);
    oct.days[24] = { ...oct.days[24], saldo: D(-2400) };
    const short = { sobraProjetada: D(-1500), totalPossivel: D(0) };
    const b = { ...baseline([oct, month(2030, 11, short), month(2030, 12, short), month(2031, 1, short)]), today: utc("2030-10-10") };
    const plan = purchasePlan(b, { porMes: D(700), meses: 10 })!;
    expect(plan.buraco).toEqual({ valor: D(2400), data: "2030-10-25" });
    expect(plan.ajusteMensal.toFixed(0)).toBe("3500"); // 1.500 short + 2.000 target
    expect(plan.porMes.toFixed(0)).toBe("4200");

    // Healthy months: the 3.000 above the target already pay the installment.
    const ok = baseline([month(2030, 1), month(2030, 2)]);
    expect(purchasePlan(ok, { porMes: D(1000), meses: 3 })).toBeNull();
    const big = purchasePlan(ok, { porMes: D(4000), meses: 3 })!;
    expect(big.compra.jaSobra.toFixed(0)).toBe("3000");
    expect(big.porMes.toFixed(0)).toBe("1000");
  });

  it("a dip before the money leaves doesn't judge the purchase (negative today, salary tomorrow, card due next month)", () => {
    const jan = month(2030, 1, { saldo: 60000 });
    jan.days[0] = { ...jan.days[0], saldo: D(-935) };
    const b = baseline([jan, month(2030, 2, { saldo: 60000 })]);
    const card = evaluateCashOuts(b, [{ date: utc("2030-02-08"), amount: D(6990) }], { fromDate: utc("2030-01-01"), pertinent: false });
    expect(card.verdict).toBe("cabe");
    expect(card.lowestAfter).toEqual({ date: "2030-02-08", value: D(53010), antes: D(60000) });

    // Paying by Pix today deepens the hole that already exists.
    const pix = evaluateCashOuts(b, [{ date: utc("2030-01-01"), amount: D(6990) }], { fromDate: utc("2030-01-01"), pertinent: false });
    expect(pix.verdict).toBe("nao_cabe");
    expect(pix.lowestAfter).toEqual({ date: "2030-01-01", value: D(-7925), antes: D(-935) });
  });

  it("a pertinent purchase paid in a month that already misses the target fura a reserva", () => {
    // Spends more than comes in: nothing to save, but plenty of saldo.
    const short = { saldo: 60000, sobraProjetada: D(-1500), totalPossivel: D(0) };
    const b = baseline([month(2030, 1, short), month(2030, 2, short)]);
    const impact = evaluateCashOuts(b, [{ date: utc("2030-02-08"), amount: D(1500) }], { fromDate: utc("2030-01-01"), pertinent: true });
    expect(impact.verdict).toBe("fura_reserva");
    expect(impact.months.map((m) => m.furaMeta)).toEqual([false, true]);
  });
});

