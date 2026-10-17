import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { cleanupDatabase, createTestUser, todayIso } from "./helpers.js";

describe("organizing tags", () => {
  afterEach(async () => {
    await cleanupDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function setup() {
    const { token } = await createTestUser();
    const auth = { Authorization: `Bearer ${token}` };
    const accountId = (
      await request(app).post("/accounts").set(auth).send({ name: "Conta", type: "checking", initialBalance: "0" }).expect(201)
    ).body.id;
    const cardId = (
      await request(app)
        .post("/cards")
        .set(auth)
        .send({ name: "Nubank", closingDay: 10, dueDay: 17, defaultPaymentAccountId: accountId })
        .expect(201)
    ).body.id;
    const tag = async (name: string) =>
      (await request(app).post("/categories").set(auth).send({ name, color: "#888888" }).expect(201)).body.id as string;
    return { auth, accountId, cardId, tag };
  }

  it("merges a tag into another, moving every use of it", async () => {
    const { auth, accountId, cardId, tag } = await setup();
    const ifood = await tag("iFood");
    const delivery = await tag("Delivery");
    await request(app).post("/transactions").set(auth).send({ accountId, type: "diario", amount: "40.00", date: todayIso(), categoryId: ifood }).expect(201);
    await request(app).post("/purchases").set(auth).send({ cardId, purchaseDate: todayIso(), description: "iFood", amount: "60.00", categoryId: ifood }).expect(201);
    await request(app)
      .post("/recurring-card-purchases")
      .set(auth)
      .send({ cardId, description: "iFood Clube", amount: "9.90", startDate: todayIso(), occurrenceCount: 3, categoryId: ifood })
      .expect(201);
    await request(app).post("/budget-items").set(auth).send({ name: "Delivery", amount: "300.00", categoryId: ifood }).expect(201);

    const res = await request(app).post(`/categories/${ifood}/merge`).set(auth).send({ intoId: delivery }).expect(200);
    expect(res.body).toMatchObject({ movedTransactions: 1, movedPurchases: 4 });

    expect(await prisma.category.findUnique({ where: { id: ifood } })).toBeNull();
    const stillTagged = { where: { categoryId: ifood } };
    expect(await prisma.transaction.count(stillTagged)).toBe(0);
    expect(await prisma.purchase.count(stillTagged)).toBe(0);
    expect(await prisma.recurringCardPurchase.count(stillTagged)).toBe(0);
    expect(await prisma.budgetItem.count(stillTagged)).toBe(0);
    expect(await prisma.purchase.count({ where: { categoryId: delivery } })).toBe(4);
  });

  it("refuses merging into itself or into another user's tag", async () => {
    const { auth, tag } = await setup();
    const a = await tag("A");
    await request(app).post(`/categories/${a}/merge`).set(auth).send({ intoId: a }).expect(400);

    const other = await setup();
    const foreign = await other.tag("Outro");
    await request(app).post(`/categories/${a}/merge`).set(auth).send({ intoId: foreign }).expect(404);
  });

  it("relabels a card purchase without touching its money", async () => {
    const { auth, cardId, tag } = await setup();
    const mercado = await tag("Mercado");
    const purchase = (
      await request(app)
        .post("/purchases")
        .set(auth)
        .send({ cardId, purchaseDate: todayIso(), description: "compra", amount: "300.00", installmentsCount: 3 })
        .expect(201)
    ).body;

    const res = await request(app).patch(`/purchases/${purchase.id}`).set(auth).send({ description: "Atacadão", categoryId: mercado }).expect(200);
    expect(res.body).toMatchObject({ description: "Atacadão", categoryId: mercado });
    expect(await prisma.installment.count({ where: { purchaseId: purchase.id } })).toBe(3);

    // Amount isn't editable here.
    await request(app).patch(`/purchases/${purchase.id}`).set(auth).send({ amount: "1.00" }).expect(200);
    expect((await prisma.purchase.findUniqueOrThrow({ where: { id: purchase.id } })).amount.toFixed(2)).toBe("300.00");

    await request(app).patch(`/purchases/${purchase.id}`).set(auth).send({ categoryId: null }).expect(200);
    expect((await prisma.purchase.findUniqueOrThrow({ where: { id: purchase.id } })).categoryId).toBeNull();
  });
});
