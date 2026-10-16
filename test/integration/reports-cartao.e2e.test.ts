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
        creditLimit: "2000.00",
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
    expect(day5.saldo).toBe("1000.00"); // unaffected until the invoice is paid

    const totalsRes = await request(app)
      .get(`/reports/monthly-totals?year=${year}&month=${month}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(totalsRes.body.cartao).toBe("120.00");
    expect(totalsRes.body.custoDeVida).toBe("120.00");
  });
});
