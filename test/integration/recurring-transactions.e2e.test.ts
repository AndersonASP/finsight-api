import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { cleanupDatabase, createTestUser } from "./helpers.js";

describe("recurring transactions", () => {
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
      .send({ name: "Conta", type: "checking", initialBalance: "0.00" })
      .expect(201);
    return { token, accountId: accountRes.body.id as string };
  }

  it("creates N monthly occurrences, one per month, when a finite count is given", async () => {
    const { token, accountId } = await setup();

    await request(app)
      .post("/recurring-transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, type: "saida", amount: "100.00", startDate: "2026-10-05", interval: "monthly", occurrenceCount: 12 })
      .expect(201);

    const listRes = await request(app).get("/transactions").set("Authorization", `Bearer ${token}`).expect(200);
    expect(listRes.body).toHaveLength(12);
    const dates = listRes.body.map((t: { date: string }) => t.date).sort();
    expect(dates[0]).toContain("2026-10-05");
    expect(dates[11]).toContain("2027-09-05");
  });

  it("'para sempre' (isOpenEnded) generates the 10-year window for the chosen interval", async () => {
    const { token, accountId } = await setup();

    await request(app)
      .post("/recurring-transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, type: "saida", amount: "50.00", startDate: "2026-10-05", interval: "annual", isOpenEnded: true })
      .expect(201);

    const listRes = await request(app).get("/transactions").set("Authorization", `Bearer ${token}`).expect(200);
    expect(listRes.body).toHaveLength(10); // annual -> 10 occurrences for a 10-year horizon
  });

  it("rejects an occurrenceCount above the hard cap", async () => {
    const { token, accountId } = await setup();

    const res = await request(app)
      .post("/recurring-transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, type: "saida", amount: "10.00", startDate: "2026-10-05", interval: "daily", occurrenceCount: 99999 });

    expect(res.status).toBe(400);
  });

  it("DELETE ?scope=future removes this occurrence and every later one, keeping past ones", async () => {
    const { token, accountId } = await setup();

    await request(app)
      .post("/recurring-transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, type: "saida", amount: "20.00", startDate: "2026-01-05", interval: "monthly", occurrenceCount: 6 })
      .expect(201);

    const listRes = await request(app).get("/transactions").set("Authorization", `Bearer ${token}`).expect(200);
    const sorted = [...listRes.body].sort(
      (a: { date: string }, b: { date: string }) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );
    const thirdOccurrence = sorted[2]; // March 2026 — delete this one and everything after.

    await request(app)
      .delete(`/transactions/${thirdOccurrence.id}?scope=future`)
      .set("Authorization", `Bearer ${token}`)
      .expect(204);

    const afterRes = await request(app).get("/transactions").set("Authorization", `Bearer ${token}`).expect(200);
    expect(afterRes.body).toHaveLength(2); // only Jan and Feb remain
  });

  it("DELETE ?scope=this (default) only removes the one occurrence, leaving the rest of the series intact", async () => {
    const { token, accountId } = await setup();

    await request(app)
      .post("/recurring-transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, type: "saida", amount: "20.00", startDate: "2026-01-05", interval: "monthly", occurrenceCount: 3 })
      .expect(201);

    const listRes = await request(app).get("/transactions").set("Authorization", `Bearer ${token}`).expect(200);
    await request(app).delete(`/transactions/${listRes.body[0].id}`).set("Authorization", `Bearer ${token}`).expect(204);

    const afterRes = await request(app).get("/transactions").set("Authorization", `Bearer ${token}`).expect(200);
    expect(afterRes.body).toHaveLength(2);
  });
});
