import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { cleanupDatabase, createTestUser } from "./helpers.js";

describe("transactions edit/delete", () => {
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
    const transactionRes = await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId: accountRes.body.id, type: "saida", amount: "50.00", date: "2026-10-05", description: "Mercado" })
      .expect(201);

    return { token, accountId: accountRes.body.id as string, transactionId: transactionRes.body.id as string };
  }

  it("GET /transactions/:id returns the full transaction", async () => {
    const { token, accountId, transactionId } = await setup();

    const res = await request(app).get(`/transactions/${transactionId}`).set("Authorization", `Bearer ${token}`).expect(200);

    expect(res.body.id).toBe(transactionId);
    expect(res.body.accountId).toBe(accountId);
    expect(res.body.type).toBe("saida");
    expect(res.body.amount).toBe("50.00");
    expect(res.body.description).toBe("Mercado");
  });

  it("404s on a transaction that belongs to another user", async () => {
    const { transactionId } = await setup();
    const { token: otherToken } = await createTestUser();

    const res = await request(app).get(`/transactions/${transactionId}`).set("Authorization", `Bearer ${otherToken}`);
    expect(res.status).toBe(404);
  });

  it("PATCH /transactions/:id edits the amount, date and description, and the balance reflects the new amount", async () => {
    const { token, accountId, transactionId } = await setup();

    await request(app)
      .patch(`/transactions/${transactionId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: "80.00", date: "2026-10-06", description: "Mercado (corrigido)" })
      .expect(200);

    const getRes = await request(app).get(`/transactions/${transactionId}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(getRes.body.amount).toBe("80.00");
    expect(getRes.body.date).toContain("2026-10-06");
    expect(getRes.body.description).toBe("Mercado (corrigido)");

    const balanceRes = await request(app)
      .get(`/accounts/${accountId}/balance`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(balanceRes.body.balance).toBe("-80.00");
  });

  it("DELETE /transactions/:id removes it and the balance no longer reflects it", async () => {
    const { token, accountId, transactionId } = await setup();

    await request(app).delete(`/transactions/${transactionId}`).set("Authorization", `Bearer ${token}`).expect(204);

    const listRes = await request(app).get("/transactions").set("Authorization", `Bearer ${token}`).expect(200);
    expect(listRes.body).toHaveLength(0);

    const balanceRes = await request(app)
      .get(`/accounts/${accountId}/balance`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(balanceRes.body.balance).toBe("0.00");
  });
});
