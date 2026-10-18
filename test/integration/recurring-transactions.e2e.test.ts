import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { cleanupDatabase, createTestUser, todayIso } from "./helpers.js";

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

  async function createSeries(token: string, accountId: string, count: number) {
    await request(app)
      .post("/recurring-transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, type: "saida", amount: "20.00", description: "Academia", startDate: "2026-01-05", interval: "monthly", occurrenceCount: count })
      .expect(201);
    return listSorted(token);
  }

  async function listSorted(token: string) {
    const res = await request(app).get("/transactions").set("Authorization", `Bearer ${token}`).expect(200);
    return [...res.body].sort(
      (a: { date: string }, b: { date: string }) => new Date(a.date).getTime() - new Date(b.date).getTime()
    ) as Array<{ id: string; date: string; amount: string; description: string }>;
  }

  it("PATCH ?scope=future applies the change to this occurrence and every later one, keeping past ones", async () => {
    const { token, accountId } = await setup();
    const series = await createSeries(token, accountId, 4);

    await request(app)
      .patch(`/transactions/${series[1].id}?scope=future`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: "25.00", date: "2026-02-10" })
      .expect(200);

    const after = await listSorted(token);
    expect(after.map((t) => t.amount)).toEqual(["20.00", "25.00", "25.00", "25.00"]);
    expect(after.map((t) => t.date.slice(0, 10))).toEqual(["2026-01-05", "2026-02-10", "2026-03-10", "2026-04-10"]);
    expect(after.every((t) => t.description === "Academia")).toBe(true);
  });

  it("PATCH ?scope=future leaves fields that didn't change alone on later occurrences edited on their own", async () => {
    const { token, accountId } = await setup();
    const series = await createSeries(token, accountId, 3);

    await request(app)
      .patch(`/transactions/${series[2].id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ description: "Academia (mês com desconto)" })
      .expect(200);
    await request(app)
      .patch(`/transactions/${series[0].id}?scope=future`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: "30.00", description: "Academia" })
      .expect(200);

    const after = await listSorted(token);
    expect(after.map((t) => t.amount)).toEqual(["30.00", "30.00", "30.00"]);
    expect(after[2].description).toBe("Academia (mês com desconto)");
  });

  it("PATCH without scope only edits the one occurrence", async () => {
    const { token, accountId } = await setup();
    const series = await createSeries(token, accountId, 3);

    await request(app)
      .patch(`/transactions/${series[0].id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: "99.00" })
      .expect(200);

    const after = await listSorted(token);
    expect(after.map((t) => t.amount)).toEqual(["99.00", "20.00", "20.00"]);
  });

  it("the account's current balance only counts occurrences already past, not every future one 'a perder de vista' eagerly generated", async () => {
    const { token, accountId } = await setup();

    // "a perder de vista" eagerly materializes a ~10-year window of monthly
    // occurrences — only one (today's) could possibly have happened yet.
    await request(app)
      .post("/recurring-transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, type: "saida", amount: "500.00", startDate: todayIso(), interval: "monthly", isOpenEnded: true })
      .expect(201);

    const balanceRes = await request(app).get(`/accounts/${accountId}/balance`).set("Authorization", `Bearer ${token}`).expect(200);
    // 119 of the 120 generated occurrences are still in the future — "right
    // now" must not subtract any of them beyond the one already due.
    expect(balanceRes.body.balance).toBe("-500.00");
  });
});
