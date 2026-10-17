import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { cleanupDatabase, createTestUser, futureYearMonth } from "./helpers.js";

describe("reports include card purchases without duplicating as a bank expense", () => {
  afterEach(async () => {
    await cleanupDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("a card purchase shows in the cartao column but does not move saldo", async () => {
    const { token } = await createTestUser();
    const accountRes = await request(app)
      .post("/accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Conta", type: "checking", initialBalance: "1000.00" })
      .expect(201);

    const cardRes = await request(app)
      .post("/cards")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Cartão",
        closingDay: 10,
        dueDay: 17,
        defaultPaymentAccountId: accountRes.body.id,
      })
      .expect(201);

    const { year, month } = futureYearMonth(1);
    await request(app)
      .post("/purchases")
      .set("Authorization", `Bearer ${token}`)
      .send({ cardId: cardRes.body.id, purchaseDate: `${year}-${String(month).padStart(2, "0")}-05`, description: "Compra", amount: "120.00" })
      .expect(201);

    const dailyRes = await request(app)
      .get(`/reports/daily-balance?year=${year}&month=${month}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const day5 = dailyRes.body.find((d: { day: number }) => d.day === 5);
    expect(day5.cartao).toBe("120.00");
    expect(day5.saldo).toBe("1000.00"); // unaffected until the invoice's due date

    const totalsRes = await request(app)
      .get(`/reports/monthly-totals?year=${year}&month=${month}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(totalsRes.body.cartao).toBe("120.00");
    expect(totalsRes.body.custoDeVida).toBe("120.00");
  });

  it("the invoice debits the account in full exactly on the installment's due date, with no manual payment step", async () => {
    const { token } = await createTestUser();
    const accountRes = await request(app)
      .post("/accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Conta", type: "checking", initialBalance: "1000.00" })
      .expect(201);

    // Closes day 10, due day 17 — a purchase on the 5th lands in the invoice that's still open.
    const cardRes = await request(app)
      .post("/cards")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Cartão", closingDay: 10, dueDay: 17, defaultPaymentAccountId: accountRes.body.id })
      .expect(201);

    const { year, month } = futureYearMonth(1);
    const monthStr = String(month).padStart(2, "0");
    await request(app)
      .post("/purchases")
      .set("Authorization", `Bearer ${token}`)
      .send({ cardId: cardRes.body.id, purchaseDate: `${year}-${monthStr}-05`, description: "Compra", amount: "300.00" })
      .expect(201);

    const dailyRes = await request(app)
      .get(`/reports/daily-balance?year=${year}&month=${month}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const day16 = dailyRes.body.find((d: { day: number }) => d.day === 16);
    const day17 = dailyRes.body.find((d: { day: number }) => d.day === 17);
    expect(day16.saldo).toBe("1000.00"); // still untouched the day before due date
    expect(day17.saldo).toBe("700.00"); // auto-debited in full on the due date itself, no "pagar fatura" step
  });

  it("GET /reports/card-spending sums purchases per card, by month or by year", async () => {
    const { token } = await createTestUser();
    const accountRes = await request(app)
      .post("/accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Conta", type: "checking", initialBalance: "1000.00" })
      .expect(201);

    const cardARes = await request(app)
      .post("/cards")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Nubank", closingDay: 10, dueDay: 17, defaultPaymentAccountId: accountRes.body.id })
      .expect(201);
    const cardBRes = await request(app)
      .post("/cards")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Inter", closingDay: 10, dueDay: 17, defaultPaymentAccountId: accountRes.body.id })
      .expect(201);

    const { year, month } = futureYearMonth(1);
    const monthStr = String(month).padStart(2, "0");
    await request(app)
      .post("/purchases")
      .set("Authorization", `Bearer ${token}`)
      .send({ cardId: cardARes.body.id, purchaseDate: `${year}-${monthStr}-05`, description: "Mercado", amount: "100.00" })
      .expect(201);
    await request(app)
      .post("/purchases")
      .set("Authorization", `Bearer ${token}`)
      .send({ cardId: cardARes.body.id, purchaseDate: `${year}-${monthStr}-06`, description: "Farmácia", amount: "50.00" })
      .expect(201);
    await request(app)
      .post("/purchases")
      .set("Authorization", `Bearer ${token}`)
      .send({ cardId: cardBRes.body.id, purchaseDate: `${year}-${monthStr}-07`, description: "Posto", amount: "200.00" })
      .expect(201);

    const monthRes = await request(app)
      .get(`/reports/card-spending?year=${year}&month=${month}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(monthRes.body).toEqual([
      { cardId: cardBRes.body.id, name: "Inter", total: "200.00" },
      { cardId: cardARes.body.id, name: "Nubank", total: "150.00" },
    ]);

    const yearRes = await request(app)
      .get(`/reports/card-spending?year=${year}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(yearRes.body).toEqual(monthRes.body); // same purchases, whole year covers the same month
  });
});
