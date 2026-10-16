import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { cleanupDatabase, createTestUser } from "./helpers.js";

describe("cards, purchases, invoices (RF-11)", () => {
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
      .send({ name: "Conta", type: "checking" })
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

    return { token, accountId: accountRes.body.id as string, cardId: cardRes.body.id as string };
  }

  it("a purchase in the open cycle enters the correct invoice", async () => {
    const { token, cardId } = await setup();

    const purchaseRes = await request(app)
      .post("/purchases")
      .set("Authorization", `Bearer ${token}`)
      .send({ cardId, purchaseDate: "2026-03-05", description: "Mercado", amount: "150.00" })
      .expect(201);

    expect(purchaseRes.body.installments).toHaveLength(1);

    const invoicesRes = await request(app).get(`/invoices?cardId=${cardId}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(invoicesRes.body).toHaveLength(1);
    expect(invoicesRes.body[0].periodYear).toBe(2026);
    expect(invoicesRes.body[0].periodMonth).toBe(3);
    expect(invoicesRes.body[0].total).toBe("150.00");
  });

  it("a purchase after closing enters the next eligible cycle", async () => {
    const { token, cardId } = await setup();

    await request(app)
      .post("/purchases")
      .set("Authorization", `Bearer ${token}`)
      .send({ cardId, purchaseDate: "2026-03-15", description: "Pós-fechamento", amount: "80.00" })
      .expect(201);

    const invoicesRes = await request(app).get(`/invoices?cardId=${cardId}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(invoicesRes.body).toHaveLength(1);
    expect(invoicesRes.body[0].periodMonth).toBe(4);
  });

  it("an installment purchase generates all future installments correctly, without duplication", async () => {
    const { token, cardId } = await setup();

    const purchaseRes = await request(app)
      .post("/purchases")
      .set("Authorization", `Bearer ${token}`)
      .send({ cardId, purchaseDate: "2026-03-05", description: "Geladeira", amount: "1200.00", installmentsCount: 4 })
      .expect(201);

    expect(purchaseRes.body.installments).toHaveLength(4);
    const sum = purchaseRes.body.installments.reduce((acc: number, i: { amount: string }) => acc + Number(i.amount), 0);
    expect(sum.toFixed(2)).toBe("1200.00");

    const invoicesRes = await request(app).get(`/invoices?cardId=${cardId}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(invoicesRes.body).toHaveLength(4); // one invoice per month, no duplicated purchase
    const months = invoicesRes.body.map((i: { periodMonth: number }) => i.periodMonth).sort();
    expect(months).toEqual([3, 4, 5, 6]);
  });

  it("deleting a purchase is blocked once any installment is invoiced (closed cycle)", async () => {
    const { token, cardId } = await setup();

    // Backdated into a cycle that's already closed.
    const purchaseRes = await request(app)
      .post("/purchases")
      .set("Authorization", `Bearer ${token}`)
      .send({ cardId, purchaseDate: "2020-01-05", description: "Antiga", amount: "20.00" })
      .expect(201);

    const res = await request(app).delete(`/purchases/${purchaseRes.body.id}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(409);
  });
});
