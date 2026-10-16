import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { cleanupDatabase, createTestUser } from "./helpers.js";

describe("detailed reports (category breakdown, monthly trend, balance history, budget vs actual)", () => {
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
    const categoryRes = await request(app)
      .post("/categories")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Mercado", color: "#2E8B57" })
      .expect(201);

    return { token, accountId: accountRes.body.id as string, categoryId: categoryRes.body.id as string };
  }

  it("category-breakdown sums a tagged lançamento and a tagged card purchase together", async () => {
    const { token, accountId, categoryId } = await setup();

    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, type: "diario", amount: "100.00", date: "2026-10-05", categoryId })
      .expect(201);

    const cardRes = await request(app)
      .post("/cards")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Cartão", creditLimit: "2000.00", closingDay: 10, dueDay: 17, defaultPaymentAccountId: accountId })
      .expect(201);
    await request(app)
      .post("/purchases")
      .set("Authorization", `Bearer ${token}`)
      .send({ cardId: cardRes.body.id, purchaseDate: "2026-10-08", description: "Compra", amount: "50.00", categoryId })
      .expect(201);

    const res = await request(app)
      .get("/reports/category-breakdown?year=2026&month=10")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].categoryId).toBe(categoryId);
    expect(res.body[0].total).toBe("150.00"); // 100 (transaction) + 50 (card purchase)
  });

  it("monthly-trend returns one point per month, oldest first, ending at the current month", async () => {
    const { token } = await setup();

    const res = await request(app).get("/reports/monthly-trend?months=3").set("Authorization", `Bearer ${token}`).expect(200);

    expect(res.body).toHaveLength(3);
    const now = new Date();
    expect(res.body[2]).toMatchObject({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 });
  });

  it("balance-history returns one point per month ending with today's actual balance", async () => {
    const { token, accountId } = await setup();

    const res = await request(app)
      .get(`/accounts/${accountId}/balance-history?months=3`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body).toHaveLength(3);
    expect(res.body[2].balance).toBe("1000.00"); // no transactions yet -> still the initial balance
  });

  it("budget-vs-actual compares a category's budget item against the real spend, respecting startsOn/endsOn", async () => {
    const { token, accountId, categoryId } = await setup();

    await request(app)
      .post("/budget-items")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Mercado mensal", amount: "300.00", categoryId, active: true })
      .expect(201);

    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, type: "diario", amount: "120.00", date: "2026-10-05", categoryId })
      .expect(201);

    const res = await request(app)
      .get("/reports/budget-vs-actual?year=2026&month=10")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ categoryId, budgeted: "300.00", actual: "120.00" });
  });

  it("budget-vs-actual excludes a budget item whose endsOn is before the requested month", async () => {
    const { token, categoryId } = await setup();

    await request(app)
      .post("/budget-items")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Mercado (encerrado)", amount: "300.00", categoryId, active: true, endsOn: "2026-09-30" })
      .expect(201);

    const res = await request(app)
      .get("/reports/budget-vs-actual?year=2026&month=10")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body).toHaveLength(0);
  });
});
