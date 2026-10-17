import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { cleanupDatabase, createTestUser, todayIso } from "./helpers.js";

describe("account deletion guards (RF: avoid crashing or silently orphaning dependents)", () => {
  afterEach(async () => {
    await cleanupDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createAccount(token: string, body: Record<string, unknown>) {
    const res = await request(app).post("/accounts").set("Authorization", `Bearer ${token}`).send(body);
    expect(res.status).toBe(201);
    return res.body as { id: string };
  }

  it("deletes a fresh, unused account with no dependencies", async () => {
    const { token } = await createTestUser();
    // type "cash", not "checking" — this test isn't about the last-checking-account guard.
    const account = await createAccount(token, { name: "Conta", type: "cash" });

    await request(app).delete(`/accounts/${account.id}`).set("Authorization", `Bearer ${token}`).expect(204);
  });

  it("deletes an account that only owns its own transaction history (it cascades)", async () => {
    const { token } = await createTestUser();
    const account = await createAccount(token, { name: "Conta", type: "cash", initialBalance: "500.00" });

    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId: account.id, type: "diario", amount: "50.00", date: todayIso() })
      .expect(201);

    await request(app).delete(`/accounts/${account.id}`).set("Authorization", `Bearer ${token}`).expect(204);
  });

  it("blocks deleting an account that's a card's default payment account", async () => {
    const { token } = await createTestUser();
    const account = await createAccount(token, { name: "Conta", type: "checking" });
    await request(app)
      .post("/cards")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Cartão", closingDay: 10, dueDay: 17, defaultPaymentAccountId: account.id })
      .expect(201);

    const res = await request(app).delete(`/accounts/${account.id}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("cartões");
  });

  it("blocks deleting a reserve account with an active reserve loan", async () => {
    const { token } = await createTestUser();
    const checking = await createAccount(token, { name: "Conta", type: "checking" });
    const reserve = await createAccount(token, { name: "Reserva", type: "savings_reserve", initialBalance: "1000.00" });
    await request(app)
      .post("/reserve-loans")
      .set("Authorization", `Bearer ${token}`)
      .send({ reserveAccountId: reserve.id, destinationAccountId: checking.id, principal: "100.00", borrowDate: todayIso() })
      .expect(201);

    const res = await request(app).delete(`/accounts/${reserve.id}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("empréstimo");
  });

  it("blocks deleting the only checking account, but allows it once a second one exists", async () => {
    const { token } = await createTestUser();
    const onlyChecking = await createAccount(token, { name: "Conta", type: "checking" });

    const blocked = await request(app).delete(`/accounts/${onlyChecking.id}`).set("Authorization", `Bearer ${token}`);
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.message).toContain("única conta corrente");

    await createAccount(token, { name: "Conta 2", type: "checking" });
    await request(app).delete(`/accounts/${onlyChecking.id}`).set("Authorization", `Bearer ${token}`).expect(204);
  });

  it("blocks deleting an account that's the counterpart of an economia transfer from another account", async () => {
    const { token } = await createTestUser();
    const checking = await createAccount(token, { name: "Conta", type: "checking", initialBalance: "500.00" });
    const reserve = await createAccount(token, { name: "Reserva", type: "savings_reserve" });
    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        accountId: checking.id,
        counterpartAccountId: reserve.id,
        type: "economia",
        amount: "100.00",
        date: todayIso(),
      })
      .expect(201);

    const res = await request(app).delete(`/accounts/${reserve.id}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("transferência");
  });
});
