import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { cleanupDatabase, createTestUser, futureYearMonth } from "./helpers.js";

describe("scenarios / simulation (RF-13)", () => {
  afterEach(async () => {
    await cleanupDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function setup() {
    const { token } = await createTestUser();
    const accountRes = await request(app)
      .post("/accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Conta", type: "checking", initialBalance: "1000.00" })
      .expect(201);

    const scenarioRes = await request(app)
      .post("/scenarios")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "E se eu comprar um notebook?" })
      .expect(201);

    return { token, accountId: accountRes.body.id as string, scenarioId: scenarioRes.body.id as string };
  }

  it("a simulated transaction does not alter the real balance until confirmed", async () => {
    const { token, accountId, scenarioId } = await setup();

    await request(app)
      .post(`/scenarios/${scenarioId}/transactions`)
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, type: "saida", amount: "5000.00", date: "2026-06-05" })
      .expect(201);

    const realBalance = await request(app)
      .get(`/accounts/${accountId}/balance`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(realBalance.body.balance).toBe("1000.00"); // untouched

    const realTransactions = await request(app).get("/transactions").set("Authorization", `Bearer ${token}`).expect(200);
    expect(realTransactions.body).toHaveLength(0); // nothing leaked into the real table

    // Confirming materializes it for real.
    await request(app).post(`/scenarios/${scenarioId}/confirm`).set("Authorization", `Bearer ${token}`).expect(200);

    const afterConfirm = await request(app)
      .get(`/accounts/${accountId}/balance`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(afterConfirm.body.balance).toBe("-4000.00");
  });

  it("discarding a scenario leaves no trace in real data and blocks further edits", async () => {
    const { token, accountId, scenarioId } = await setup();

    await request(app)
      .post(`/scenarios/${scenarioId}/transactions`)
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, type: "saida", amount: "300.00", date: "2026-06-05" })
      .expect(201);

    await request(app).delete(`/scenarios/${scenarioId}`).set("Authorization", `Bearer ${token}`).expect(204);

    const realBalance = await request(app)
      .get(`/accounts/${accountId}/balance`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(realBalance.body.balance).toBe("1000.00");

    const rejected = await request(app)
      .post(`/scenarios/${scenarioId}/transactions`)
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, type: "saida", amount: "1.00", date: "2026-06-05" });
    expect(rejected.status).toBe(409); // discarded scenarios are no longer editable
  });

  it("a projection identifies a future deficit and its impact on the savings percentage", async () => {
    const { token, accountId, scenarioId } = await setup();

    // Real income this period, so there's a baseline savings percentage.
    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, type: "entrada", amount: "1000.00", date: "2026-06-01" })
      .expect(201);
    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, type: "economia", amount: "200.00", date: "2026-06-02" })
      .expect(201);

    // Simulated big expense that would push the account negative.
    await request(app)
      .post(`/scenarios/${scenarioId}/transactions`)
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, type: "saida", amount: "2500.00", date: "2026-06-10" })
      .expect(201);

    const res = await request(app)
      .get(`/scenarios/${scenarioId}/projection?from=2026-06-01&to=2026-06-15`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body.deficitDaysBefore).toBe(0); // real balance alone never goes negative
    expect(res.body.deficitDaysAfter).toBeGreaterThan(0); // the simulated expense pushes it negative
    expect(res.body.savingsImpact.percentBefore).toBe("20.00"); // 200 / 1000
    expect(res.body.savingsImpact.percentAfter).toBe("20.00"); // unaffected: the sim only added a `saida`

    // Real data still shows no deficit — the simulation never touched it.
    const realBalance = await request(app)
      .get(`/accounts/${accountId}/balance`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(Number(realBalance.body.balance)).toBeGreaterThan(0);
  });

  it("daily-balance overlays the scenario's shadow transaction and purchase on top of the real table, flagging which days are simulated", async () => {
    const { token, accountId, scenarioId } = await setup();
    const { year, month } = futureYearMonth(1);
    const monthStr = String(month).padStart(2, "0");

    const cardRes = await request(app)
      .post("/cards")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Cartão", closingDay: 10, dueDay: 17, defaultPaymentAccountId: accountId })
      .expect(201);

    // Day 5: a real saida AND a shadow saida — both should sum, and the day
    // must come back flagged (it has a simulated contribution too).
    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, type: "saida", amount: "100.00", date: `${year}-${monthStr}-05` })
      .expect(201);
    await request(app)
      .post(`/scenarios/${scenarioId}/transactions`)
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, type: "saida", amount: "50.00", date: `${year}-${monthStr}-05` })
      .expect(201);

    // Day 6: a shadow-only card purchase (cartao column), due on day 17 (same cycle, before closing).
    await request(app)
      .post(`/scenarios/${scenarioId}/purchases`)
      .set("Authorization", `Bearer ${token}`)
      .send({ cardId: cardRes.body.id, purchaseDate: `${year}-${monthStr}-06`, description: "Simulado", amount: "300.00" })
      .expect(201);

    const realOnly = await request(app)
      .get(`/reports/daily-balance?year=${year}&month=${month}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const realDay5 = realOnly.body.find((d: { day: number }) => d.day === 5);
    expect(realDay5.saida).toBe("100.00");
    expect(realDay5.saidaShadow).toBe(false);

    const withScenario = await request(app)
      .get(`/scenarios/${scenarioId}/daily-balance?year=${year}&month=${month}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const day5 = withScenario.body.find((d: { day: number }) => d.day === 5);
    const day6 = withScenario.body.find((d: { day: number }) => d.day === 6);
    const day17 = withScenario.body.find((d: { day: number }) => d.day === 17);
    expect(day5.saida).toBe("150.00"); // real + shadow
    expect(day5.saidaShadow).toBe(true);
    expect(day6.cartao).toBe("300.00");
    expect(day6.cartaoShadow).toBe(true);
    expect(day17.saldo).toBe("550.00"); // 1000 - 150 (saida) - 300 (installment due) = 550
  });

  it("day-detail returns the real items read-only and the scenario's own shadow items separately, and deleting a shadow item removes it from both views", async () => {
    const { token, accountId, scenarioId } = await setup();
    const { year, month } = futureYearMonth(1);
    const date = `${year}-${String(month).padStart(2, "0")}-05`;

    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, type: "saida", amount: "20.00", date, description: "Real" })
      .expect(201);
    const shadowRes = await request(app)
      .post(`/scenarios/${scenarioId}/transactions`)
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, type: "saida", amount: "80.00", date, description: "Simulado" })
      .expect(201);

    const detail = await request(app)
      .get(`/scenarios/${scenarioId}/day-detail?date=${date}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(detail.body.real).toHaveLength(1);
    expect(detail.body.real[0].description).toBe("Real");
    expect(detail.body.shadow).toHaveLength(1);
    expect(detail.body.shadow[0].description).toBe("Simulado");
    expect(detail.body.shadow[0].kind).toBe("transaction");

    await request(app)
      .delete(`/scenarios/${scenarioId}/transactions/${shadowRes.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(204);

    const afterDelete = await request(app)
      .get(`/scenarios/${scenarioId}/day-detail?date=${date}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(afterDelete.body.real).toHaveLength(1); // untouched
    expect(afterDelete.body.shadow).toHaveLength(0);
  });

  it("DELETE on a purchase that belongs to a different scenario (or doesn't exist) 404s", async () => {
    const { token, scenarioId } = await setup();
    const res = await request(app)
      .delete(`/scenarios/${scenarioId}/purchases/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});
