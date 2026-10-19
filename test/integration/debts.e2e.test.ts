import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { cleanupDatabase, createTestUser, todayIso } from "./helpers.js";

describe("debts", () => {
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
    return { token, accountId: accountRes.body.id as string };
  }

  it("creates a debt and lists it", async () => {
    const { token } = await setup();

    const res = await request(app)
      .post("/debts")
      .set("Authorization", `Bearer ${token}`)
      .send({ creditor: "Banco X", type: "consignado", currentBalance: "5000.00", installmentAmount: "200.00", installmentsTotal: 25 })
      .expect(201);

    expect(res.body.status).toBe("em_dia");

    const listRes = await request(app).get("/debts").set("Authorization", `Bearer ${token}`).expect(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].creditor).toBe("Banco X");
  });

  it("a payment reduces the debt balance, debits the account, and tracks installments paid", async () => {
    const { token, accountId } = await setup();

    const debtRes = await request(app)
      .post("/debts")
      .set("Authorization", `Bearer ${token}`)
      .send({ creditor: "Banco X", type: "consignado", currentBalance: "5000.00", installmentAmount: "200.00", installmentsTotal: 25 })
      .expect(201);

    const paymentRes = await request(app)
      .post(`/debts/${debtRes.body.id}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, amount: "200.00", paymentDate: "2026-10-10" })
      .expect(201);

    expect(paymentRes.body.balanceAfter).toBe("4800.00");

    const detailRes = await request(app).get(`/debts/${debtRes.body.id}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(detailRes.body.debt.currentBalance).toBe("4800.00");
    expect(detailRes.body.debt.installmentsPaid).toBe(1);
    expect(detailRes.body.debt.status).toBe("em_dia");

    const balanceRes = await request(app)
      .get(`/accounts/${accountId}/balance`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(balanceRes.body.balance).toBe("1800.00"); // 2000 - 200
  });

  it("paying off the full remaining balance marks the debt as paga", async () => {
    const { token, accountId } = await setup();

    const debtRes = await request(app)
      .post("/debts")
      .set("Authorization", `Bearer ${token}`)
      .send({ creditor: "Cartão Y", type: "cartao_vencido", currentBalance: "300.00", status: "vencida" })
      .expect(201);

    await request(app)
      .post(`/debts/${debtRes.body.id}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, amount: "300.00", paymentDate: "2026-10-10" })
      .expect(201);

    const detailRes = await request(app).get(`/debts/${debtRes.body.id}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(detailRes.body.debt.status).toBe("paga");
    expect(detailRes.body.debt.currentBalance).toBe("0.00");
  });

  it("refuses a payment on a fixed-installment debt: the calendar already pays it down", async () => {
    const { token, accountId } = await setup();
    const debt = await request(app)
      .post("/debts")
      .set("Authorization", `Bearer ${token}`)
      .send({ creditor: "Banco", type: "financiamento", installmentAmount: "500.00", installmentsTotal: 24, installmentDueDay: 10, currentInstallment: 3 })
      .expect(201);

    await request(app)
      .post(`/debts/${debt.body.id}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, amount: "500.00", paymentDate: todayIso() })
      .expect(400);
  });

  it("rejects a payment larger than the current balance", async () => {
    const { token, accountId } = await setup();

    const debtRes = await request(app)
      .post("/debts")
      .set("Authorization", `Bearer ${token}`)
      .send({ creditor: "Banco X", type: "emprestimo_pessoal", currentBalance: "100.00" })
      .expect(201);

    const res = await request(app)
      .post(`/debts/${debtRes.body.id}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, amount: "150.00", paymentDate: "2026-10-10" });

    expect(res.status).toBe(400);
  });

  it("updateDebt lets the user bump the balance when the bank applies a new fee", async () => {
    const { token } = await setup();

    const debtRes = await request(app)
      .post("/debts")
      .set("Authorization", `Bearer ${token}`)
      .send({ creditor: "Cartão Y", type: "cartao_vencido", currentBalance: "300.00", status: "vencida" })
      .expect(201);

    await request(app)
      .patch(`/debts/${debtRes.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ currentBalance: "340.00", notes: "juro de outubro" })
      .expect(200);

    const detailRes = await request(app).get(`/debts/${debtRes.body.id}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(detailRes.body.debt.currentBalance).toBe("340.00");
  });
});
