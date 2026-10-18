import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import type { Impact, MonthImpact, PurchasePlan } from "../../src/modules/insights/purchase-impact.js";
import { brl, buildWhatIfText, monthName, shortDate, type TextOption, type WhatIfTextInput } from "../../src/modules/insights/what-if-text.js";

const D = (v: string | number) => new Prisma.Decimal(v);
const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const today = utc("2030-10-10");

function monthImpact(overrides: Partial<MonthImpact> = {}): MonthImpact {
  return {
    mes: "2030-10",
    pagaNoMes: D(0),
    menorSaldoAntes: { date: "2030-10-20", value: D(5000) },
    menorSaldoDepois: { date: "2030-10-20", value: D(2340) },
    saldoFimDoMesAntes: D(6000),
    saldoFimDoMesDepois: D(3000),
    guardaAntes: D(2500),
    guardaDepois: D(2500),
    metaValor: D(2000),
    entradas: D(10000),
    folga: D(700),
    economiaFeita: D(0),
    jaNegativoSemACompra: false,
    menorSaldoPago: null,
    ficaNegativoComACompra: false,
    aperta: false,
    furaMeta: false,
    ...overrides,
  };
}

function option(overrides: Partial<TextOption> & { months?: MonthImpact[]; verdict?: Impact["verdict"] } = {}): TextOption {
  const { months = [monthImpact()], verdict = "cabe", ...rest } = overrides;
  // Fixtures name only menorSaldoDepois/Antes: treat them as the lowest day after paying.
  const paid = (m: MonthImpact) =>
    m.menorSaldoPago ?? (m.menorSaldoDepois ? { ...m.menorSaldoDepois, antes: m.menorSaldoAntes?.value ?? m.menorSaldoDepois.value } : null);
  const lowestAfter = months.reduce<Impact["lowestAfter"]>((acc, m) => {
    const p = paid(m);
    return p && (!acc || p.value.lessThan(acc.value)) ? p : acc;
  }, null);
  return {
    method: "pix",
    installments: 1,
    installmentAmount: D(3000),
    total: D(3000),
    firstDue: today,
    impact: { verdict, pertinent: true, months, lowestAfter },
    discount: D(0),
    floatGain: D(0),
    ...rest,
  };
}

function input(overrides: Partial<WhatIfTextInput>): WhatIfTextInput {
  return {
    today,
    recurring: false,
    decided: false,
    chosen: option(),
    others: [],
    metaPercent: D(20),
    priority: { kind: "reserva", meses: D("2.1"), metaMeses: 6 },
    reserveSaldo: D(4000),
    diarioPorDia: D(200),
    entradas: D(10000),
    paths: [],
    plan: null,
    planHow: null,
    ...overrides,
  };
}

describe("what-if text", () => {
  it("formats money, months and dates the Brazilian way", () => {
    expect(brl(D("1234.56"))).toBe("R$ 1.235");
    expect(brl(D("-420.4"))).toBe("R$ -420");
    expect(brl(D("1234567"))).toBe("R$ 1.234.567");
    expect(monthName("2030-12", today)).toBe("dezembro");
    expect(monthName("2031-01", today)).toBe("janeiro de 2031");
    expect(shortDate("2030-11-12")).toBe("12/nov");
  });

  it("cabe on the card: when it's due, the lowest saldo, what's still saved, the translation", () => {
    const chosen = option({
      method: "card",
      cardName: "Nubank",
      firstDue: utc("2030-12-02"),
      months: [
        monthImpact(),
        monthImpact({ mes: "2030-12", pagaNoMes: D(3000), guardaDepois: D(2200), menorSaldoDepois: { date: "2030-12-01", value: D(4100) } }),
      ],
    });
    const pix = option({ verdict: "aperta", months: [monthImpact({ menorSaldoDepois: { date: "2030-10-20", value: D(90) } })] });
    const text = buildWhatIfText(input({ decided: true, chosen, others: [pix] }));
    expect(text.manchete).toBe("Pode comprar. Melhor no Nubank em 1x.");
    expect(text.motivos).toEqual([
      "A fatura vence em 2/dez: o dinheiro fica com você por mais 53 dias.",
      "Você ainda guarda 22% em dezembro (meta: 20%).",
      "No Pix seu saldo cairia para R$ 90 em 20/out.",
      "Equivale a 15 dias do seu diário e a 30% da sua entrada do mês.",
    ]);
    // Without a comparison, the lowest saldo takes the third line.
    expect(buildWhatIfText(input({ chosen })).motivos[2]).toBe("Seu menor saldo fica em R$ 2.340 (20/out).");
    expect(text.caminhos).toEqual([]);
  });

  it("Pix discount beats the card float", () => {
    const chosen = option({ discount: D(150), total: D(2850) });
    const card = option({ method: "card", cardName: "Nubank", floatGain: D(12) });
    const text = buildWhatIfText(input({ decided: true, chosen, others: [card] }));
    expect(text.manchete).toBe("Pode comprar. Melhor no Pix/débito.");
    expect(text.motivos).toContain("O desconto no Pix economiza R$ 150; esperar a fatura renderia só R$ 12.");
  });

  it("fura a reserva: how much less is saved, why the reserve comes first, and the paths", () => {
    const month = monthImpact({ mes: "2030-12", pagaNoMes: D(3000), guardaAntes: D(2600), guardaDepois: D(800), furaMeta: true });
    const chosen = option({ verdict: "fura_reserva", months: [month] });
    const in4x = option({ method: "card", cardName: "Inter", installments: 4, installmentAmount: D(750) });
    const text = buildWhatIfText(
      input({
        chosen,
        paths: [
          { kind: "outra_forma", option: in4x },
          { kind: "esperar", mes: "2031-03", date: "2031-03-06", option: chosen },
          { kind: "juntar", porMes: D(500), mes: "2031-04" },
        ],
      })
    );
    expect(text.manchete).toBe("Dá para pagar, mas fura sua reserva.");
    expect(text.motivos.slice(0, 2)).toEqual([
      "Em dezembro você guardaria 8% em vez de 20% (R$ 1.800 a menos).",
      "Sua reserva cobre 2,1 de 6 meses: ela vem antes.",
    ]);
    expect(text.caminhos).toEqual([
      "No Inter em 4x de R$ 750 cabe sem furar a reserva.",
      "Ou espere até março de 2031: a partir de 6/mar cabe no Pix/débito.",
      "Ou junte para ela: R$ 500/mês além da sua meta, pronta em abril de 2031.",
    ]);
  });

  it("expensive debt comes before the purchase", () => {
    const chosen = option({ verdict: "fura_reserva", months: [monthImpact({ guardaDepois: D(800), furaMeta: true })] });
    const text = buildWhatIfText(input({ chosen, priority: { kind: "divida", creditor: "Rotativo Itaú" } }));
    expect(text.motivos[1]).toBe("Você tem dívida cara com Rotativo Itaú: quitá-la vem antes.");
  });

  it("não cabe: names the month it turns negative and the reserve as the only way out", () => {
    const chosen = option({
      verdict: "nao_cabe",
      months: [monthImpact({ mes: "2030-11", ficaNegativoComACompra: true, menorSaldoDepois: { date: "2030-11-12", value: D(-420) } })],
    });
    const text = buildWhatIfText(input({ chosen, paths: [{ kind: "sem_margem" }] }));
    expect(text.manchete).toBe("Agora não cabe.");
    expect(text.motivos.slice(0, 2)).toEqual(["Seu saldo fica negativo em novembro (até R$ -420 em 12/nov).", "Só daria tirando dinheiro da reserva."]);
    expect(text.caminhos).toEqual(["Hoje não sobra nada acima da sua meta para juntar: o caminho é cortar gastos ou aumentar a entrada."]);
  });

  it("não cabe when the saldo is already negative without the purchase", () => {
    const chosen = option({
      verdict: "nao_cabe",
      months: [
        monthImpact({
          jaNegativoSemACompra: true,
          ficaNegativoComACompra: true,
          menorSaldoAntes: { date: "2030-10-31", value: D(-2433) },
          menorSaldoDepois: { date: "2030-10-31", value: D(-5433) },
        }),
      ],
    });
    const text = buildWhatIfText(input({ chosen, reserveSaldo: D(0) }));
    expect(text.motivos.slice(0, 2)).toEqual([
      "Seu saldo já fica negativo em 31/out mesmo sem a compra (R$ -2.433); a compra aumenta esse buraco em R$ 3.000.",
      "Antes de comprar, resolva esse buraco — ou confira se falta lançar alguma entrada (ex.: salário).",
    ]);
  });

  it("recurring: the 12-month cost", () => {
    const chosen = option({ installmentAmount: D(120), total: D(120) });
    const text = buildWhatIfText(input({ chosen, recurring: true }));
    expect(text.manchete).toBe("Cabe no seu mês.");
    expect(text.motivos.at(-1)).toBe("São R$ 1.440 em 12 meses; por mês, equivale a 1 dia do seu diário e a 1% da sua entrada do mês.");
  });

  it("plan: the hole now, the monthly cut to save the target, the purchase in installments, the total", () => {
    const plan: PurchasePlan = {
      buraco: { valor: D("2432.91"), data: "2030-10-31" },
      ajusteMensal: D(2875),
      sobraTipica: D("-1525.6"),
      metaTipica: D("1349.4"),
      compra: { porMes: D(699), meses: 10, jaSobra: D(0) },
      porMes: D(3574),
    };
    const chosen = option({
      verdict: "nao_cabe",
      months: [monthImpact({ menorSaldoDepois: { date: "2030-10-31", value: D(-5400) }, ficaNegativoComACompra: true })],
    });
    const text = buildWhatIfText(input({ chosen, plan, planHow: { kind: "parcelado", cardName: "Itaú", installments: 10 } }));
    expect(text.planoLinhas).toEqual([
      "Agora: R$ 2.433 para tirar o saldo do vermelho até 31/out — esse buraco já existe sem a compra.",
      "Todo mês: gastar R$ 2.875 a menos. Hoje sai R$ 1.526 a mais do que entra, e guardar 20% pede R$ 1.349.",
      "Para a compra: mais R$ 699/mês por 10 meses, parcelando no Itaú em 10x.",
      "Ao todo: R$ 3.574/mês a menos de gastos (ou a mais de entrada) durante 10 meses.",
    ]);
  });

  it("plan with margin above the target: only what the purchase still lacks", () => {
    const plan: PurchasePlan = {
      buraco: null,
      ajusteMensal: D(0),
      sobraTipica: D(2500),
      metaTipica: D(2000),
      compra: { porMes: D(1000), meses: 6, jaSobra: D(500) },
      porMes: D(500),
    };
    const text = buildWhatIfText(input({ chosen: option({ verdict: "fura_reserva", months: [monthImpact({ guardaDepois: D(1500), furaMeta: true })] }), plan, planHow: { kind: "juntar_antes", months: 6 } }));
    expect(text.planoLinhas).toEqual(["Para a compra: juntar R$ 1.000/mês por 6 meses antes e pagar no Pix. R$ 500 disso já sobram acima da meta."]);
  });

  it("fura a reserva in a month that already misses the target without the purchase", () => {
    const month = monthImpact({ mes: "2030-11", pagaNoMes: D(699), guardaAntes: D(0), guardaDepois: D(0), furaMeta: true });
    const text = buildWhatIfText(input({ chosen: option({ verdict: "fura_reserva", months: [month] }) }));
    expect(text.motivos[0]).toBe("Em novembro você não guardaria nada (meta: 20%, R$ 2.000) — mesmo sem a compra o mês não chega à meta.");
  });
});

