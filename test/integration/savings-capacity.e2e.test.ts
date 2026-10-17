import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { cleanupDatabase, createTestUser, futureYearMonth } from "./helpers.js";

const pad = (n: number) => String(n).padStart(2, "0");

describe("insights: quanto dá para guardar", () => {
  afterEach(async () => {
    await cleanupDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Next month: every day is still a projection, so the numbers don't
  // depend on what day the suite runs.
  const { year, month } = futureYearMonth(1);
  const numDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = (d: number) => `${year}-${pad(month)}-${pad(d)}`;

  async function setup(initialBalance: string) {
    const { token } = await createTestUser();
    const auth = { Authorization: `Bearer ${token}` };
    const accountId = (
      await request(app).post("/accounts").set(auth).send({ name: "Conta", type: "checking", initialBalance }).expect(201)
    ).body.id as string;
    // Previsão de diário of exactly R$ 30/day in the target month.
    await request(app).post("/budget-items").set(auth).send({ name: "Diário", amount: (30 * numDays).toFixed(2) }).expect(201);
    const tx = (type: string, amount: string, date: string, extra: Record<string, unknown> = {}) =>
      request(app).post("/transactions").set(auth).send({ accountId, type, amount, date, ...extra }).expect(201);
    return { auth, accountId, tx };
  }

  const capacity = async (auth: Record<string, string>, y = year, m = month) =>
    (await request(app).get(`/insights/savings-capacity?year=${y}&month=${m}`).set(auth).expect(200)).body;

  it("is the month's projected surplus when the saldo comfortably allows it", async () => {
    const { auth, accountId, tx } = await setup("20000.00");
    await tx("entrada", "5000.00", day(5));
    await tx("saida", "1500.00", day(10));
    const cardId = (
      await request(app)
        .post("/cards")
        .set(auth)
        .send({ name: "Nubank", closingDay: 1, dueDay: 8, defaultPaymentAccountId: accountId })
        .expect(201)
    ).body.id;
    await request(app).post("/purchases").set(auth).send({ cardId, purchaseDate: day(12), description: "Mercado", amount: "300.00" }).expect(201);

    const c = await capacity(auth);
    const expectedSobra = 5000 - 1500 - 300 - 30 * numDays;
    expect(c.diarioPrevisto).toBe((30 * numDays).toFixed(2));
    expect(c.sobraProjetada).toBe(expectedSobra.toFixed(2));
    expect(c.podeGuardarAgora).toBe(expectedSobra.toFixed(2));
    expect(c.limitadoPor).toBe("sobra");
    expect(c.metaPercent).toBe("20");
    expect(c.metaValor).toBe("1000.00");
    expect(c.faltaParaMeta).toBe("0.00");
  });

  it("never suggests saving money the account will need before the salary lands", async () => {
    const { auth, tx } = await setup("200.00");
    await tx("saida", "1500.00", day(2));
    await tx("entrada", "5000.00", day(28));

    const c = await capacity(auth);
    expect(Number(c.sobraProjetada)).toBeGreaterThan(0);
    expect(Number(c.menorSaldoProjetado)).toBeLessThan(0);
    expect(c.podeGuardarAgora).toBe("0.00");
    expect(c.limitadoPor).toBe("saldo");
    // Honest about the target even when it isn't reachable.
    expect(c.faltaParaMeta).toBe("1000.00");
  });

  it("counts savings already made and uses the user's own goal", async () => {
    const { auth, tx } = await setup("20000.00");
    await tx("entrada", "5000.00", day(5));
    await tx("economia", "400.00", day(6));
    await request(app)
      .post("/savings-goals")
      .set(auth)
      .send({ periodType: "monthly", periodYear: year, periodMonth: month, targetPercent: "30" })
      .expect(201);

    const c = await capacity(auth);
    const pode = 5000 - 400 - 30 * numDays;
    expect(c.economiaFeita).toBe("400.00");
    expect(c.podeGuardarAgora).toBe(pode.toFixed(2));
    expect(c.totalPossivel).toBe((400 + pode).toFixed(2));
    expect(c.metaPercent).toBe("30");
    expect(c.metaValor).toBe("1500.00");
  });

  it("points to an expensive debt first", async () => {
    const { auth } = await setup("1000.00");
    await request(app).post("/debts").set(auth).send({ creditor: "Cartão X", type: "outro", currentBalance: "3000.00", monthlyInterestRate: "8" }).expect(201);
    await request(app).post("/debts").set(auth).send({ creditor: "Barato", type: "outro", currentBalance: "500.00", monthlyInterestRate: "1" }).expect(201);

    const c = await capacity(auth);
    expect(c.destino.kind).toBe("divida");
    expect(c.destino.title).toBe("Quitar Cartão X");
  });

  it("then to the emergency reserve until it covers 6 months", async () => {
    const { auth, tx } = await setup("1000.00");
    await request(app).post("/accounts").set(auth).send({ name: "Reserva", type: "savings_reserve", initialBalance: "3000.00" }).expect(201);
    // Last month's cost of living: R$ 2000.
    const last = futureYearMonth(-1);
    await tx("saida", "2000.00", `${last.year}-${pad(last.month)}-15`);

    const c = await capacity(auth);
    expect(c.destino.kind).toBe("reserva");
    expect(c.destino.detail).toContain("1,5 meses");
  });

  it("doesn't call the reserve complete when there's no spending history to measure it", async () => {
    const { auth } = await setup("1000.00");
    const c = await capacity(auth);
    expect(c.destino.kind).toBe("reserva");
    expect(c.destino.detail).toContain("Ainda não há meses completos");
  });

  it("only suggests investing once the reserve covers 6 months", async () => {
    const { auth, tx } = await setup("1000.00");
    await request(app).post("/accounts").set(auth).send({ name: "Reserva", type: "savings_reserve", initialBalance: "13000.00" }).expect(201);
    const last = futureYearMonth(-1);
    await tx("saida", "2000.00", `${last.year}-${pad(last.month)}-15`);

    const c = await capacity(auth);
    expect(c.destino.kind).toBe("investir");
  });

  it("a month already over has nothing left to move", async () => {
    const { auth } = await setup("1000.00");
    const past = futureYearMonth(-2);
    const c = await capacity(auth, past.year, past.month);
    expect(c.isPast).toBe(true);
    expect(c.podeGuardarAgora).toBe("0.00");
  });
});
