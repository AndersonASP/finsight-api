import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { cleanupDatabase, createTestUser, futureYearMonth } from "./helpers.js";

describe("recurring card purchases (subscriptions)", () => {
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
    const cardRes = await request(app)
      .post("/cards")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Cartão", closingDay: 10, dueDay: 17, defaultPaymentAccountId: accountRes.body.id })
      .expect(201);
    return { token, accountId: accountRes.body.id as string, cardId: cardRes.body.id as string };
  }

  it("creates N monthly purchases, each a single (non-installment) occurrence", async () => {
    const { token, cardId } = await setup();

    await request(app)
      .post("/recurring-card-purchases")
      .set("Authorization", `Bearer ${token}`)
      .send({ cardId, description: "Netflix", amount: "39.90", startDate: "2026-03-05", occurrenceCount: 6 })
      .expect(201);

    const purchasesRes = await request(app).get(`/purchases?cardId=${cardId}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(purchasesRes.body).toHaveLength(6);
    for (const purchase of purchasesRes.body) {
      expect(purchase.installmentsCount).toBe(1);
      expect(purchase.installments).toHaveLength(1);
    }
    const dates = purchasesRes.body.map((p: { purchaseDate: string }) => p.purchaseDate).sort();
    expect(dates[0]).toContain("2026-03-05");
    expect(dates[5]).toContain("2026-08-05");

    const invoicesRes = await request(app).get(`/invoices?cardId=${cardId}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(invoicesRes.body).toHaveLength(6); // one invoice per month, no duplication
  });

  it("'a perder de vista' (isOpenEnded) generates the 10-year monthly window", async () => {
    const { token, cardId } = await setup();

    await request(app)
      .post("/recurring-card-purchases")
      .set("Authorization", `Bearer ${token}`)
      .send({ cardId, description: "Spotify", amount: "21.90", startDate: "2026-03-05", isOpenEnded: true })
      .expect(201);

    const purchasesRes = await request(app).get(`/purchases?cardId=${cardId}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(purchasesRes.body).toHaveLength(120);
  });

  it("rejects an occurrenceCount above the hard cap", async () => {
    const { token, cardId } = await setup();

    const res = await request(app)
      .post("/recurring-card-purchases")
      .set("Authorization", `Bearer ${token}`)
      .send({ cardId, description: "Netflix", amount: "39.90", startDate: "2026-03-05", occurrenceCount: 9999 });

    expect(res.status).toBe(400);
  });

  it("DELETE ?scope=future removes this occurrence and every later one, keeping past ones", async () => {
    const { token, cardId } = await setup();
    const { year, month } = futureYearMonth(2);
    const startDate = `${year}-${String(month).padStart(2, "0")}-05`;

    await request(app)
      .post("/recurring-card-purchases")
      .set("Authorization", `Bearer ${token}`)
      .send({ cardId, description: "Netflix", amount: "39.90", startDate, occurrenceCount: 6 })
      .expect(201);

    const listRes = await request(app).get(`/purchases?cardId=${cardId}`).set("Authorization", `Bearer ${token}`).expect(200);
    const sorted = [...listRes.body].sort(
      (a: { purchaseDate: string }, b: { purchaseDate: string }) => new Date(a.purchaseDate).getTime() - new Date(b.purchaseDate).getTime()
    );
    const thirdOccurrence = sorted[2]; // March 2026 — delete this one and everything after.

    await request(app)
      .delete(`/purchases/${thirdOccurrence.id}?scope=future`)
      .set("Authorization", `Bearer ${token}`)
      .expect(204);

    const afterRes = await request(app).get(`/purchases?cardId=${cardId}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(afterRes.body).toHaveLength(2); // only Jan and Feb remain
  });

  it("DELETE ?scope=this (default) only removes the one occurrence, leaving the rest of the series intact", async () => {
    const { token, cardId } = await setup();
    const { year, month } = futureYearMonth(2);
    const startDate = `${year}-${String(month).padStart(2, "0")}-05`;

    await request(app)
      .post("/recurring-card-purchases")
      .set("Authorization", `Bearer ${token}`)
      .send({ cardId, description: "Netflix", amount: "39.90", startDate, occurrenceCount: 3 })
      .expect(201);

    const listRes = await request(app).get(`/purchases?cardId=${cardId}`).set("Authorization", `Bearer ${token}`).expect(200);
    await request(app).delete(`/purchases/${listRes.body[0].id}`).set("Authorization", `Bearer ${token}`).expect(204);

    const afterRes = await request(app).get(`/purchases?cardId=${cardId}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(afterRes.body).toHaveLength(2);
  });
});
