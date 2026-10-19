import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { addMonthsIso, cleanupDatabase, createTestUser, todayIso } from "./helpers.js";

describe("compra de bem (método R5)", () => {
  afterEach(async () => {
    await cleanupDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function setup() {
    const { token } = await createTestUser();
    const auth = { Authorization: `Bearer ${token}` };
    const account = async (name: string, type: string, initialBalance: string) =>
      (await request(app).post("/accounts").set(auth).send({ name, type, initialBalance }).expect(201)).body.id as string;
    const checking = await account("Conta", "checking", "30000.00");
    const reserve = await account("Reserva", "savings_reserve", "100000.00");
    // Custo de vida: R$ 5.000 no mês passado → a reserva cobre 20 meses.
    await request(app)
      .post("/transactions")
      .set(auth)
      .send({ accountId: checking, type: "saida", amount: "5000.00", date: addMonthsIso(todayIso(), -1) })
      .expect(201);
    return { auth, checking, reserve };
  }

  const apartment = (reserve: string) => ({
    description: "Apartamento",
    assetKind: "imovel",
    price: "320000.00",
    taxes: "15000.00",
    fees: "5000.00",
    downPayment: "84000.00",
    downPaymentAccountId: reserve,
    financing: { installments: 360, installmentAmount: "2500.00", principal: "256000.00" },
  });

  it("shows the real cost and the impact on total, líquido, % líquido, reserve and division", async () => {
    const { auth, reserve } = await setup();
    const res = (await request(app).post("/insights/asset-purchase").set(auth).send(apartment(reserve)).expect(200)).body;

    expect(res.custo).toEqual({ preco: "320000.00", impostos: "15000.00", documentacao: "5000.00", total: "340000.00" });
    // 25k na corrente (30k − a saída do mês passado) + 100k de reserva.
    expect(res.antes).toMatchObject({ total: "125000.00", saldoDevedor: "0.00", percentLiquido: "100.0" });
    expect(res.depois).toMatchObject({
      total: "381000.00",
      saldoDevedor: "256000.00",
      liquido: "125000.00",
      percentLiquido: "32.8",
      alertaAbaixoDe40: true,
      reserva: "16000.00",
      reservaMeses: "3.2",
    });
    expect(res.reserva).toMatchObject({ metaMeses: 8, ficaAbaixoDaMeta: true, entradaSaiDaReserva: true });
    // 25k na corrente pagam só 10 parcelas de 2.500, sem renda nenhuma.
    expect(res.veredito).toBe("nao_cabe");
    expect(res.linhas[0]).toContain("Custo real: R$ 340.000");
    expect(res.linhas.join(" ")).toContain("abaixo de 40%");
  });

  it("without financing, the entrada must cover the whole cost", async () => {
    const { auth, checking } = await setup();
    await request(app)
      .post("/insights/asset-purchase")
      .set(auth)
      .send({ assetKind: "veiculo", price: "40000.00", downPayment: "10000.00", downPaymentAccountId: checking })
      .expect(400);
    const res = (
      await request(app)
        .post("/insights/asset-purchase")
        .set(auth)
        .send({ description: "Carro", assetKind: "veiculo", price: "20000.00", fees: "1500.00", downPaymentAccountId: checking })
        .expect(200)
    ).body;
    expect(res.pagamento.entrada).toBe("21500.00");
    expect(res.linhas.join(" ")).toContain("Carro desvaloriza");
  });

  it("registers the bem at total cost, the entrada outside the custo de vida, and the linked financing", async () => {
    const { auth, reserve, checking } = await setup();
    const created = (
      await request(app)
        .post("/insights/asset-purchase/register")
        .set(auth)
        .send({ ...apartment(reserve), name: "Apartamento", financing: { ...apartment(reserve).financing, installmentAccountId: checking } })
        .expect(201)
    ).body;
    expect(created.assetId).toBeTruthy();
    expect(created.debtId).toBeTruthy();
    expect(created.recurringTransactionId).toBeTruthy();

    const wealth = (await request(app).get("/wealth").set(auth).expect(200)).body;
    const bens = wealth.assets.find((g: { group: string }) => g.group === "bens");
    expect(bens.items[0]).toMatchObject({ value: "340000.00" });
    expect(bens.items[0].details).toMatchObject({ debtOutstanding: "256000.00", equity: "84000.00" });
    expect(wealth.totalLiabilities).toBe("256000.00");

    const [y, m] = todayIso().split("-").map(Number);
    const totals = (await request(app).get(`/reports/monthly-totals?year=${y}&month=${m}`).set(auth).expect(200)).body;
    expect(totals.aquisicoes).toBe("84000.00");
    expect(Number(totals.custoDeVida)).toBeLessThan(84000); // the entrada isn't cost
  });

  it("flags a reserve or investimentos bloco sitting in a single place (informative)", async () => {
    const { auth } = await setup();
    const wealth = (await request(app).get("/wealth").set(auth).expect(200)).body;
    expect(wealth.diagnostico.concentracao).toEqual([{ bloco: "reserva", item: "Reserva", percent: "100" }]);
  });
});
