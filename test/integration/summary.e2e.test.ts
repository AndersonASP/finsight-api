import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { cleanupDatabase, createTestUser, todayIso } from "./helpers.js";

describe("insights summary (widget)", () => {
  afterEach(async () => {
    await cleanupDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("returns saldo, month end, tightest day, savings and next unchecked bills", async () => {
    const { token } = await createTestUser();
    const auth = { Authorization: `Bearer ${token}` };
    const accountId = (
      await request(app).post("/accounts").set(auth).send({ name: "Conta", type: "checking", initialBalance: "1000.00" }).expect(201)
    ).body.id;
    const inTwoDays = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    await request(app)
      .post("/recurring-transactions")
      .set(auth)
      .send({ accountId, type: "saida", amount: "300.00", description: "Internet", startDate: inTwoDays, interval: "monthly", occurrenceCount: 2 })
      .expect(201);
    const later = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await request(app)
      .post("/recurring-transactions")
      .set(auth)
      .send({ accountId, type: "saida", amount: "80.00", description: "Luz", startDate: later, interval: "monthly", occurrenceCount: 1 })
      .expect(201);

    const s = (await request(app).get("/insights/summary").set(auth).expect(200)).body;
    expect(s.saldoHoje).toBe("1000.00");
    expect(s.proximasContas.map((b: { description: string }) => b.description)).toEqual(["Internet", "Luz"]);
    expect(s.proximasContas[0]).toMatchObject({ amount: "300.00", dueDate: inTwoDays });
    expect(s.podeGuardar).toEqual(expect.any(String));
    // The tightest day ahead can't be above today's saldo once bills go out.
    if (s.menorSaldo) expect(Number(s.menorSaldo.value)).toBeLessThanOrEqual(1000);
  });

  it("leaves checked bills out", async () => {
    const { token } = await createTestUser();
    const auth = { Authorization: `Bearer ${token}` };
    const accountId = (
      await request(app).post("/accounts").set(auth).send({ name: "Conta", type: "checking", initialBalance: "0" }).expect(201)
    ).body.id;
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await request(app)
      .post("/recurring-transactions")
      .set(auth)
      .send({ accountId, type: "saida", amount: "50.00", description: "Água", startDate: tomorrow, interval: "monthly", occurrenceCount: 1 })
      .expect(201);
    const [bill] = (await request(app).get(`/bills?from=${todayIso()}&to=${tomorrow}`).set(auth).expect(200)).body;
    await request(app).patch(`/transactions/${bill.id}/paid`).set(auth).send({ paid: true }).expect(200);

    const s = (await request(app).get("/insights/summary").set(auth).expect(200)).body;
    expect(s.proximasContas).toHaveLength(0);
  });
});
