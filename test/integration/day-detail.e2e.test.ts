import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { cleanupDatabase, createTestUser } from "./helpers.js";

describe("day detail (drill-down from a day's saldo)", () => {
  afterEach(async () => {
    await cleanupDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("lists a regular transaction with its tag, and an installment with its parcela count", async () => {
    const { token } = await createTestUser();
    const account = await request(app)
      .post("/accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Conta", type: "checking" })
      .expect(201);
    const category = await request(app)
      .post("/categories")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Carro", color: "#D2531E" })
      .expect(201);
    const card = await request(app)
      .post("/cards")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Cartão",
        closingDay: 28,
        dueDay: 2,
        defaultPaymentAccountId: account.body.id,
      })
      .expect(201);

    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        accountId: account.body.id,
        type: "saida",
        amount: "150.00",
        date: "2026-09-02",
        categoryId: category.body.id,
        description: "Aluguel",
      })
      .expect(201);

    // Purchase on 2026-08-25 closing 28 -> first installment due 2026-09-02 (dueDay=2, next month since dueDay<=closingDay).
    await request(app)
      .post("/purchases")
      .set("Authorization", `Bearer ${token}`)
      .send({
        cardId: card.body.id,
        purchaseDate: "2026-08-25",
        description: "Parcela do carro",
        amount: "1107.60",
        categoryId: category.body.id,
        installmentsCount: 17,
      })
      .expect(201);

    const res = await request(app)
      .get("/reports/day-detail?date=2026-09-02")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body).toHaveLength(2);

    const transactionItem = res.body.find((i: { type: string }) => i.type === "saida");
    expect(transactionItem.description).toBe("Aluguel");
    expect(transactionItem.amount).toBe("150.00");
    expect(transactionItem.categoryName).toBe("Carro");
    expect(transactionItem.installment).toBeNull();

    const installmentItem = res.body.find((i: { type: string }) => i.type === "cartao");
    expect(installmentItem.description).toBe("Parcela do carro");
    expect(installmentItem.amount).toBe("65.15"); // 1107.60 / 17, rounded down (remainder lands on the last installment)
    expect(installmentItem.categoryName).toBe("Carro");
    expect(installmentItem.installment).toEqual({ sequence: 1, count: 17 });
  });

  it("tags recurring items with their position and the series length (null when open-ended), cash and card alike", async () => {
    const { token } = await createTestUser();
    const auth = { Authorization: `Bearer ${token}` };
    const account = await request(app).post("/accounts").set(auth).send({ name: "Conta", type: "checking" }).expect(201);
    const card = await request(app)
      .post("/cards")
      .set(auth)
      .send({ name: "Cartão", closingDay: 28, dueDay: 10, defaultPaymentAccountId: account.body.id })
      .expect(201);

    const recurring = (body: object) => request(app).post("/recurring-transactions").set(auth).send(body).expect(201);
    await recurring({ accountId: account.body.id, type: "saida", amount: "100.00", description: "Curso", startDate: "2026-01-05", interval: "monthly", occurrenceCount: 5 });
    await recurring({ accountId: account.body.id, type: "saida", amount: "50.00", description: "Academia", startDate: "2026-01-05", interval: "monthly", isOpenEnded: true });
    const subscription = (body: object) => request(app).post("/recurring-card-purchases").set(auth).send(body).expect(201);
    await subscription({ cardId: card.body.id, description: "Revista", amount: "20.00", startDate: "2026-01-05", occurrenceCount: 3 });
    await subscription({ cardId: card.body.id, description: "Streaming", amount: "30.00", startDate: "2026-01-05", isOpenEnded: true });

    const res = await request(app).get("/reports/day-detail?from=2026-02-01&to=2026-02-28").set(auth).expect(200);
    const byDescription = (d: string) => res.body.find((i: { description: string }) => i.description === d);

    expect(byDescription("Curso").recurring).toMatchObject({ occurrenceIndex: 1, count: 5 });
    expect(byDescription("Academia").recurring).toMatchObject({ occurrenceIndex: 1, count: null });
    // Purchase on 2026-01-05 (before closing 28) -> invoice due 2026-02-10.
    expect(byDescription("Revista").recurring).toMatchObject({ occurrenceIndex: 0, count: 3 });
    expect(byDescription("Streaming").recurring).toMatchObject({ occurrenceIndex: 0, count: null });
  });

  it("a 'esta e as futuras' delete shortens the series count shown on the remaining occurrences", async () => {
    const { token } = await createTestUser();
    const auth = { Authorization: `Bearer ${token}` };
    const account = await request(app).post("/accounts").set(auth).send({ name: "Conta", type: "checking" }).expect(201);
    await request(app)
      .post("/recurring-transactions")
      .set(auth)
      .send({ accountId: account.body.id, type: "saida", amount: "100.00", startDate: "2026-01-05", interval: "monthly", occurrenceCount: 5 })
      .expect(201);
    const march = await request(app).get("/reports/day-detail?date=2026-03-05").set(auth).expect(200);
    await request(app).delete(`/transactions/${march.body[0].id}?scope=future`).set(auth).expect(204);

    const res = await request(app).get("/reports/day-detail?date=2026-02-05").set(auth).expect(200);
    expect(res.body[0].recurring).toMatchObject({ occurrenceIndex: 1, count: 2 });
  });

  it("returns an empty list for a day with no activity", async () => {
    const { token } = await createTestUser();
    const res = await request(app)
      .get("/reports/day-detail?date=2026-01-01")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual([]);
  });

  it("returns every day's items at once for a from/to range (used for the offline cache)", async () => {
    const { token } = await createTestUser();
    const account = await request(app)
      .post("/accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Conta", type: "checking" })
      .expect(201);
    for (const [date, description] of [
      ["2026-09-01", "Primeiro"],
      ["2026-09-30", "Último"],
      ["2026-10-01", "Fora do intervalo"],
    ]) {
      await request(app)
        .post("/transactions")
        .set("Authorization", `Bearer ${token}`)
        .send({ accountId: account.body.id, type: "saida", amount: "10.00", date, description })
        .expect(201);
    }

    const res = await request(app)
      .get("/reports/day-detail?from=2026-09-01&to=2026-09-30")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body.map((i: { description: string }) => i.description).sort()).toEqual(["Primeiro", "Último"]);
    expect(res.body.map((i: { date: string }) => i.date).sort()).toEqual(["2026-09-01", "2026-09-30"]);
  });

  it("rejects a range whose end is before its start", async () => {
    const { token } = await createTestUser();
    await request(app)
      .get("/reports/day-detail?from=2026-09-30&to=2026-09-01")
      .set("Authorization", `Bearer ${token}`)
      .expect(400);
  });
});
