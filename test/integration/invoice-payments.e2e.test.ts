import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { cleanupDatabase, createTestUser, futureYearMonth } from "./helpers.js";

describe("invoice payments (RF-12)", () => {
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
      .send({ name: "Conta", type: "checking", initialBalance: "2000.00" })
      .expect(201);
    const cardRes = await request(app)
      .post("/cards")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Cartão",
        creditLimit: "5000.00",
        closingDay: 10,
        dueDay: 17,
        defaultPaymentAccountId: accountRes.body.id,
      })
      .expect(201);
    const purchaseRes = await request(app)
      .post("/purchases")
      .set("Authorization", `Bearer ${token}`)
      .send({ cardId: cardRes.body.id, purchaseDate: "2026-04-05", description: "Compra", amount: "500.00" })
      .expect(201);
    const invoiceId = purchaseRes.body.installments[0].invoiceId as string;

    return { token, accountId: accountRes.body.id as string, invoiceId };
  }

  it("paying an invoice does not duplicate the purchase as a new expense", async () => {
    const { token, accountId, invoiceId } = await setup();

    await request(app)
      .post(`/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, paymentDate: "2026-04-17", amount: "500.00" })
      .expect(201);

    // The expense (R$500) only ever appears once, via the original purchase —
    // there must be no `transactions` row created for the payment.
    const transactionsRes = await request(app).get("/transactions").set("Authorization", `Bearer ${token}`).expect(200);
    expect(transactionsRes.body).toHaveLength(0);

    const invoiceRes = await request(app).get(`/invoices/${invoiceId}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(invoiceRes.body.paid).toBe("500.00");
    expect(invoiceRes.body.remaining).toBe("0.00");
    expect(invoiceRes.body.status).toBe("paid");
  });

  it("an early (antecipado) payment changes the projection on its effective date", async () => {
    // Uses its own fresh fixture (instead of the shared setup()) so its dates
    // can be anchored to a month safely after "now" — these balance queries
    // pass an explicit `date=`, which only counts the account's
    // initialBalance from its real createdAt forward (see getAccountBalance).
    const { token } = await createTestUser();
    const { year, month } = futureYearMonth(1);
    const pad = (n: number) => String(n).padStart(2, "0");
    const accountRes = await request(app)
      .post("/accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Conta", type: "checking", initialBalance: "2000.00" })
      .expect(201);
    const cardRes = await request(app)
      .post("/cards")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Cartão",
        creditLimit: "5000.00",
        closingDay: 10,
        dueDay: 17,
        defaultPaymentAccountId: accountRes.body.id,
      })
      .expect(201);
    const purchaseRes = await request(app)
      .post("/purchases")
      .set("Authorization", `Bearer ${token}`)
      .send({ cardId: cardRes.body.id, purchaseDate: `${year}-${pad(month)}-05`, description: "Compra", amount: "500.00" })
      .expect(201);
    const accountId = accountRes.body.id as string;
    const invoiceId = purchaseRes.body.installments[0].invoiceId as string;

    // Before any payment, balance already reflects purchase not yet due.
    const before = await request(app)
      .get(`/accounts/${accountId}/balance?date=${year}-${pad(month)}-12`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(before.body.balance).toBe("2000.00"); // unaffected pre-payment

    await request(app)
      .post(`/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, paymentDate: `${year}-${pad(month)}-12`, amount: "500.00" }) // paid 5 days before the 17th due date
      .expect(201);

    const onPaymentDate = await request(app)
      .get(`/accounts/${accountId}/balance?date=${year}-${pad(month)}-12`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(onPaymentDate.body.balance).toBe("1500.00"); // reflected exactly on the effective payment date

    const dayBefore = await request(app)
      .get(`/accounts/${accountId}/balance?date=${year}-${pad(month)}-11`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(dayBefore.body.balance).toBe("2000.00"); // not yet reflected the day before
  });

  it("a partial payment leaves the remainder as an open obligation", async () => {
    const { token, accountId, invoiceId } = await setup();

    await request(app)
      .post(`/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, paymentDate: "2026-04-17", amount: "200.00" })
      .expect(201);

    const invoiceRes = await request(app).get(`/invoices/${invoiceId}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(invoiceRes.body.status).toBe("partially_paid");
    expect(invoiceRes.body.paid).toBe("200.00");
    expect(invoiceRes.body.remaining).toBe("300.00");
  });

  it("known interest/charges on a partial payment are tracked separately from principal", async () => {
    const { token, accountId, invoiceId } = await setup();

    const res = await request(app)
      .post(`/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, paymentDate: "2026-04-20", amount: "300.00", interestAmount: "15.50" })
      .expect(201);

    expect(res.body.amount).toBe("300.00");
    expect(res.body.interestAmount).toBe("15.50");
  });

  it("rejects a zero or negative payment amount", async () => {
    const { token, accountId, invoiceId } = await setup();
    const res = await request(app)
      .post(`/invoices/${invoiceId}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, paymentDate: "2026-04-17", amount: "0.00" });
    expect(res.status).toBe(400);
  });
});
