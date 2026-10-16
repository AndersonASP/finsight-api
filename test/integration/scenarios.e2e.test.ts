import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { cleanupDatabase, createTestUser } from "./helpers.js";

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
});
