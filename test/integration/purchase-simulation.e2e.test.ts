import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { cleanupDatabase, createTestUser, futureYearMonth } from "./helpers.js";

const pad = (n: number) => String(n).padStart(2, "0");

describe("insights: posso comprar? (simulação)", () => {
  afterEach(async () => {
    await cleanupDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Next month, so results don't depend on the day the suite runs.
  const { year, month } = futureYearMonth(1);
  const day = (d: number) => `${year}-${pad(month)}-${pad(d)}`;

  async function setup(initialBalance: string) {
    const { token } = await createTestUser();
    const auth = { Authorization: `Bearer ${token}` };
    const accountId = (
      await request(app).post("/accounts").set(auth).send({ name: "Conta", type: "checking", initialBalance }).expect(201)
    ).body.id as string;
    return { auth, accountId };
  }

  const simulate = (auth: Record<string, string>, body: Record<string, unknown>, status = 200) =>
    request(app).post("/insights/simulate-purchase").set(auth).send(body).expect(status);

  async function rowCounts() {
    return Promise.all([prisma.purchase.count(), prisma.installment.count(), prisma.transaction.count(), prisma.invoice.count()]);
  }

  it("fits when the saldo stays comfortable, and saves nothing", async () => {
    const { auth, accountId } = await setup("20000.00");
    await request(app).post("/transactions").set(auth).send({ accountId, type: "entrada", amount: "5000.00", date: day(5) }).expect(201);
    const before = await rowCounts();

    const res = (await simulate(auth, { amount: "3000.00", date: day(10) })).body;
    expect(res.veredito).toBe("cabe");
    expect(res.compra).toMatchObject({ formaDePagamento: "débito/Pix", parcelas: 1, vencimentos: [{ data: day(10), valor: "3000.00" }] });
    const [m] = res.meses;
    expect(Number(m.saldoFimDoMesAntes) - Number(m.saldoFimDoMesDepois)).toBeCloseTo(3000);
    expect(res.simulado).toBe(true);

    expect(await rowCounts()).toEqual(before);
  });

  it("doesn't fit when it would turn the saldo negative", async () => {
    const { auth } = await setup("1000.00");
    const res = (await simulate(auth, { amount: "3000.00", date: day(10) })).body;
    expect(res.veredito).toBe("nao_cabe");
    expect(res.motivo).toContain("deixa o saldo negativo");
    expect(res.meses[0]).toMatchObject({ jaNegativoSemACompra: false, ficaNegativoComACompra: true });
  });

  it("spreads a card purchase over its invoice due dates", async () => {
    const { auth, accountId } = await setup("50000.00");
    const cardId = (
      await request(app)
        .post("/cards")
        .set(auth)
        .send({ name: "Nubank", closingDay: 1, dueDay: 8, defaultPaymentAccountId: accountId })
        .expect(201)
    ).body.id;
    const before = await rowCounts();

    const res = (await simulate(auth, { amount: "3000.00", installments: 10, cardId, date: day(10) })).body;
    expect(res.compra).toMatchObject({ formaDePagamento: "Nubank", parcelas: 10, valorParcela: "300.00" });
    expect(res.compra.vencimentos).toHaveLength(10);
    // Bought after the 1st (closing): first parcela on the 8th of the following month.
    const next = futureYearMonth(2);
    expect(res.compra.vencimentos[0].data).toBe(`${next.year}-${pad(next.month)}-08`);
    // Purchase month pays nothing; the 10 following months pay 300 each.
    expect(res.meses[0].pagaNoMes).toBe("0.00");
    expect(res.meses.slice(1).map((m: { pagaNoMes: string }) => m.pagaNoMes)).toEqual(Array(10).fill("300.00"));
    expect(res.veredito).toBe("cabe");

    expect(await rowCounts()).toEqual(before);
  });

  it("débito/Pix counts in full against the purchase month's savings", async () => {
    const { auth, accountId } = await setup("20000.00");
    await request(app).post("/transactions").set(auth).send({ accountId, type: "entrada", amount: "5000.00", date: day(5) }).expect(201);
    const res = (await simulate(auth, { amount: "1000.00", date: day(10) })).body;
    const { mes, antes, depois } = res.daParaGuardarNoPrimeiroVencimento;
    expect(mes).toBe(`${year}-${pad(month)}`);
    expect(Number(antes) - Number(depois)).toBeCloseTo(1000);
  });

  it("a card purchase only weighs on the month of each due installment", async () => {
    const { auth, accountId } = await setup("20000.00");
    const next = futureYearMonth(2);
    await request(app).post("/transactions").set(auth).send({ accountId, type: "entrada", amount: "5000.00", date: `${next.year}-${pad(next.month)}-02` }).expect(201);
    const cardId = (
      await request(app)
        .post("/cards")
        .set(auth)
        .send({ name: "Nubank", closingDay: 1, dueDay: 8, defaultPaymentAccountId: accountId })
        .expect(201)
    ).body.id;
    const res = (await simulate(auth, { amount: "1000.00", installments: 4, cardId, date: day(10) })).body;
    const { mes, antes, depois } = res.daParaGuardarNoPrimeiroVencimento;
    expect(mes).toBe(`${next.year}-${pad(next.month)}`);
    expect(Number(antes) - Number(depois)).toBeCloseTo(250);
  });

  it("validates the input", async () => {
    const { auth } = await setup("1000.00");
    await simulate(auth, { amount: "0", date: day(10) }, 400);
    await simulate(auth, { amount: "10.00", date: "2020-01-01" }, 400);
    const other = await setup("0");
    const foreignCard = (
      await request(app)
        .post("/cards")
        .set(other.auth)
        .send({ name: "X", closingDay: 1, dueDay: 8, defaultPaymentAccountId: other.accountId })
        .expect(201)
    ).body.id;
    await simulate(auth, { amount: "10.00", cardId: foreignCard, date: day(10) }, 404);
  });
});
