import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { addMonthsIso, cleanupDatabase, createTestUser, todayIso } from "./helpers.js";

type Group = { group: string; total: string; items: { id: string; name: string; value: string; source: string; stale: boolean; details?: Record<string, unknown> }[] };

function daysAgoIso(n: number) {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

describe("wealth (patrimônio)", () => {
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

    const checking = await account("Conta", "checking", "1000.00");
    const reserve = await account("Reserva", "savings_reserve", "6000.00");
    const investment = await account("Tesouro", "investment", "0.00");
    return { auth, checking, reserve, investment };
  }

  const get = async (auth: Record<string, string>) => (await request(app).get("/wealth").set(auth).expect(200)).body;
  const groupOf = (groups: Group[], key: string) => groups.find((g) => g.group === key);

  it("values investments as the last informed value plus later aportes", async () => {
    const { auth, checking, investment } = await setup();
    await request(app)
      .post(`/accounts/${investment}/balance-snapshots`)
      .set(auth)
      .send({ snapshotDate: daysAgoIso(1), balance: "10500.00" })
      .expect(201);
    // Aporte after the snapshot: moves 500 from Conta into the investment.
    await request(app)
      .post("/transactions")
      .set(auth)
      .send({ accountId: checking, type: "economia", amount: "500.00", date: todayIso(), counterpartAccountId: investment })
      .expect(201);

    const wealth = await get(auth);
    const investimentos = groupOf(wealth.assets, "investimentos")!;
    expect(investimentos.items[0]).toMatchObject({ value: "11000.00", source: "informado", stale: false });
    expect(groupOf(wealth.assets, "disponivel")!.total).toBe("500.00");
    expect(groupOf(wealth.assets, "reserva")!.total).toBe("6000.00");
  });

  it("flags an investment never valued as stale", async () => {
    const { auth } = await setup();
    const wealth = await get(auth);
    expect(groupOf(wealth.assets, "investimentos")!.items[0].stale).toBe(true);
  });

  it("keeps card installments still to come apart from the saldo devedor, but out of the financeiro", async () => {
    const { auth, checking } = await setup();
    const card = (
      await request(app)
        .post("/cards")
        .set(auth)
        .send({ name: "Nubank", closingDay: 10, dueDay: 17, defaultPaymentAccountId: checking })
        .expect(201)
    ).body.id;
    await request(app)
      .post("/purchases")
      .set(auth)
      .send({ cardId: card, purchaseDate: todayIso(), description: "TV", amount: "300.00", installmentsCount: 3 })
      .expect(201);
    await request(app)
      .post("/recurring-card-purchases")
      .set(auth)
      .send({ cardId: card, description: "Netflix", amount: "39.90", startDate: todayIso(), occurrenceCount: 12 })
      .expect(201);

    const wealth = await get(auth);
    const cartao = groupOf(wealth.commitments, "cartao")!;
    expect(cartao.total).toBe("339.90");
    expect(cartao.items[0].source).toBe("calculado");
    // Not saldo devedor (método: only financed bens/debts) …
    expect(groupOf(wealth.liabilities, "cartao")).toBeUndefined();
    expect(wealth.totalLiabilities).toBe("0.00");
    expect(wealth.cardCommitments).toBe("339.90");
    expect(wealth.netWorth).toBe("7000.00");
    // … but already-spent money: it comes out of what's actually free.
    expect(wealth.financialNetWorth).toBe("6660.10");
  });

  it("derives fixed-installment debts from the calendar ('parcela X de Y')", async () => {
    const { auth } = await setup();
    const res = await request(app)
      .post("/debts")
      .set(auth)
      .send({
        creditor: "Consignado",
        type: "consignado",
        installmentAmount: "450.00",
        installmentsTotal: 48,
        installmentDueDay: 10,
        currentInstallment: 13,
      })
      .expect(201);
    expect(res.body.kind).toBe("parcela_fixa");

    const today = new Date();
    // #13 is due this month on the 10th: paid once that day has passed.
    const paid = today.getUTCDate() > 10 ? 13 : 12;
    const wealth = await get(auth);
    const item = groupOf(wealth.liabilities, "parcela_fixa")!.items[0];
    expect(item.value).toBe((450 * (48 - paid)).toFixed(2));
    expect(item.details).toMatchObject({ installmentsPaid: paid, installmentsTotal: 48 });
  });

  it("uses informed balances for variable debts and flags them after 30 days", async () => {
    const { auth } = await setup();
    const res = await request(app)
      .post("/debts")
      .set(auth)
      .send({ creditor: "Rotativo", type: "cartao_vencido", currentBalance: "2500.00", monthlyInterestRate: "12" })
      .expect(201);

    let item = groupOf((await get(auth)).liabilities, "saldo_variavel")!.items[0];
    expect(item).toMatchObject({ value: "2500.00", source: "informado", stale: false });
    expect(item.details).toMatchObject({ monthlyInterestCost: "300.00" });

    await prisma.debt.update({ where: { id: res.body.id }, data: { balanceUpdatedAt: new Date(daysAgoIso(40)) } });
    item = groupOf((await get(auth)).liabilities, "saldo_variavel")!.items[0];
    expect(item.stale).toBe(true);

    // Informing a new balance resets the date.
    await request(app).patch(`/debts/${res.body.id}`).set(auth).send({ currentBalance: "2300.00" }).expect(200);
    item = groupOf((await get(auth)).liabilities, "saldo_variavel")!.items[0];
    expect(item).toMatchObject({ value: "2300.00", stale: false });
  });

  it("adds informed assets and separates the financial net worth", async () => {
    const { auth } = await setup();
    await request(app).post("/assets").set(auth).send({ name: "Apartamento", kind: "imovel", value: "300000.00" }).expect(201);
    await request(app).post("/assets").set(auth).send({ name: "Reembolso", kind: "a_receber", value: "800.00" }).expect(201);
    await request(app).post("/debts").set(auth).send({ creditor: "Acordo", type: "outro", currentBalance: "1800.00" }).expect(201);

    const wealth = await get(auth);
    // 1000 conta + 6000 reserva + 0 investimento + 800 a receber + 300000 imóvel − 1800
    expect(wealth.totalAssets).toBe("307800.00");
    expect(wealth.totalLiabilities).toBe("1800.00");
    expect(wealth.netWorth).toBe("306000.00");
    expect(wealth.financialNetWorth).toBe("6000.00");
    expect(wealth.netWorthPercent).toBe("99.4"); // 306000 / 307800
    expect(wealth.netWorthAlert).toBe(false);
  });

  it("warns (método R2) when the patrimônio líquido is under 40% of the total", async () => {
    const { auth } = await setup();
    // Imóvel lançado pelo custo total (320k + 20k de ITBI/escritura) e o financiamento como dívida.
    await request(app).post("/assets").set(auth).send({ name: "Apartamento", kind: "imovel", value: "340000.00" }).expect(201);
    await request(app)
      .post("/debts")
      .set(auth)
      .send({ creditor: "Financiamento", type: "financiamento", currentBalance: "256000.00" })
      .expect(201);

    const wealth = await get(auth);
    expect(wealth.totalAssets).toBe("347000.00");
    expect(wealth.totalLiabilities).toBe("256000.00");
    expect(wealth.netWorth).toBe("91000.00");
    expect(wealth.netWorthPercent).toBe("26.2");
    expect(wealth.netWorthMinPercent).toBe(40);
    expect(wealth.netWorthAlert).toBe(true);
  });

  it("measures the reserve against the user's target (8 months by default) and says how much is missing", async () => {
    const { auth, checking } = await setup();
    const date = addMonthsIso(todayIso(), -1);
    await request(app).post("/transactions").set(auth).send({ accountId: checking, type: "saida", amount: "1000.00", date }).expect(201);

    let wealth = await get(auth);
    expect(wealth).toMatchObject({ reserveMonths: "6.0", reserveTargetMonths: 8, reserveMissing: "2000.00", reserveComplete: false });

    await request(app).patch("/settings").set(auth).send({ reserveTargetMonths: 6 }).expect(200);
    wealth = await get(auth);
    expect(wealth).toMatchObject({ reserveTargetMonths: 6, reserveMissing: "0.00", reserveComplete: true });
  });

  it("keeps reserve loans out of the liabilities and reports them apart", async () => {
    const { auth, checking, reserve } = await setup();
    await request(app)
      .post("/reserve-loans")
      .set(auth)
      .send({ reserveAccountId: reserve, destinationAccountId: checking, principal: "600.00", borrowDate: todayIso() })
      .expect(201);

    const wealth = await get(auth);
    expect(wealth.liabilities).toHaveLength(0);
    expect(wealth.netWorth).toBe("7000.00");
    expect(Number(wealth.reserveLoansOwed)).toBeGreaterThanOrEqual(600);
  });

  it("keeps one snapshot per month, served as history", async () => {
    const { auth } = await setup();
    await get(auth);
    await request(app).post("/assets").set(auth).send({ name: "Carro", kind: "veiculo", value: "40000.00" }).expect(201);
    await get(auth);

    const history = (await request(app).get("/wealth/history").set(auth).expect(200)).body;
    expect(history).toHaveLength(1);
    expect(history[0].netWorth).toBe("47000.00");
  });

  it("rejects 'parcela X' beyond the total", async () => {
    const { auth } = await setup();
    await request(app)
      .post("/debts")
      .set(auth)
      .send({ creditor: "X", type: "outro", installmentAmount: "10.00", installmentsTotal: 5, installmentDueDay: 5, currentInstallment: 6 })
      .expect(400);
  });
  describe("diagnóstico (ficando mais rico ou mais pobre)", () => {
    const lastMonth = () => {
      const [y, m] = addMonthsIso(todayIso(), -1).split("-").map(Number);
      return { year: y, month: m };
    };
    const userIdOf = async () => (await prisma.user.findFirstOrThrow()).id;

    it("with no history, uses the average monthly result of the last months", async () => {
      const { auth, checking } = await setup();
      const date = addMonthsIso(todayIso(), -1);
      const tx = (type: string, amount: string) =>
        request(app).post("/transactions").set(auth).send({ accountId: checking, type, amount, date }).expect(201);
      await tx("entrada", "3000.00");
      await tx("saida", "2000.00");

      const { diagnostico } = await get(auth);
      expect(diagnostico).toMatchObject({ tendencia: "crescendo", variacao: "1000.00", base: "media_mensal", desde: null });
    });

    it("compares the TOTAL net worth with last month's snapshot, so a car losing value shows up (método R7)", async () => {
      const { auth } = await setup();
      await request(app).post("/assets").set(auth).send({ name: "Carro", kind: "veiculo", value: "32000.00" }).expect(201);
      // Mês passado: 7000 em dinheiro + carro valendo 40000. Hoje o carro vale 32000.
      await prisma.netWorthSnapshot.create({
        data: { userId: await userIdOf(), ...lastMonth(), assets: "47000", liabilities: "0", netWorth: "47000", financialNetWorth: "7000" },
      });

      const { diagnostico } = await get(auth);
      expect(diagnostico).toMatchObject({
        tendencia: "caindo",
        variacao: "-8000.00",
        base: "historico",
        desde: lastMonth(),
        variacaoFinanceira: "0.00", // em dinheiro nada mudou — o patrimônio caiu mesmo assim
      });
    });

    it("reports interest paid and expensive debt, and no trend without data", async () => {
      const { auth } = await setup();
      await request(app)
        .post("/debts")
        .set(auth)
        .send({ creditor: "Rotativo", type: "cartao_vencido", currentBalance: "2500.00", monthlyInterestRate: "12" })
        .expect(201);
      const { diagnostico } = await get(auth);
      expect(diagnostico).toMatchObject({
        tendencia: null,
        variacao: null,
        jurosMensais: "300.00",
        dividaCara: "2500.00",
        reserva: "6000.00",
        disponivelNegativo: false,
      });
    });
  });
});
