import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { cleanupDatabase, createTestUser, todayIso } from "./helpers.js";

describe("quick entries (Apple Pay / Shortcuts)", () => {
  afterEach(async () => {
    await cleanupDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function setup({ cards = 1 } = {}) {
    const { token } = await createTestUser();
    const auth = { Authorization: `Bearer ${token}` };
    const accountRes = await request(app)
      .post("/accounts")
      .set(auth)
      .send({ name: "Conta Itaú", type: "checking", initialBalance: "1000.00" })
      .expect(201);
    const accountId = accountRes.body.id as string;
    const cardIds: string[] = [];
    for (let i = 0; i < cards; i++) {
      const cardRes = await request(app)
        .post("/cards")
        .set(auth)
        .send({ name: i === 0 ? "Nubank" : `Cartão ${i}`, closingDay: 10, dueDay: 17, defaultPaymentAccountId: accountId })
        .expect(201);
      cardIds.push(cardRes.body.id);
    }
    return { auth, accountId, cardIds };
  }

  it("logs on the only card when the wallet card isn't mapped", async () => {
    const { auth, cardIds } = await setup();
    const res = await request(app)
      .post("/quick-entries")
      .set(auth)
      .send({ amount: 26, merchant: "Padaria Pão Quente", cardName: "Nubank Ultravioleta", date: todayIso() })
      .expect(201);

    expect(res.body).toMatchObject({ kind: "purchase", amount: "26.00", paymentName: "Nubank", categoryName: null });
    const purchase = await prisma.purchase.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(purchase.cardId).toBe(cardIds[0]);
    expect(purchase.description).toBe("Padaria Pão Quente");
  });

  it("uses the wallet mapping: crédito → card purchase, débito → diário lançamento", async () => {
    const { auth, accountId, cardIds } = await setup({ cards: 2 });
    await request(app).put("/quick-entries/mappings").set(auth).send({ walletName: "Cartão 1 Visa", cardId: cardIds[1] }).expect(200);
    await request(app).put("/quick-entries/mappings").set(auth).send({ walletName: "Itaú Débito", accountId }).expect(200);

    const credit = await request(app)
      .post("/quick-entries")
      .set(auth)
      .send({ amount: "R$ 1.234,56", merchant: "Loja", cardName: "  cartão 1 VISA " })
      .expect(201);
    expect(credit.body).toMatchObject({ kind: "purchase", amount: "1234.56", paymentName: "Cartão 1" });

    const debit = await request(app)
      .post("/quick-entries")
      .set(auth)
      .send({ amount: "12,90", merchant: "Mercado", cardName: "Itaú Débito", date: todayIso() })
      .expect(201);
    expect(debit.body).toMatchObject({ kind: "transaction", amount: "12.90", paymentName: "Conta Itaú" });
    const transaction = await prisma.transaction.findUniqueOrThrow({ where: { id: debit.body.id } });
    expect(transaction.type).toBe("diario");
    expect(transaction.accountId).toBe(accountId);
  });

  it("refuses an ambiguous card instead of guessing", async () => {
    const { auth } = await setup({ cards: 2 });
    const res = await request(app)
      .post("/quick-entries")
      .set(auth)
      .send({ amount: 10, merchant: "Café", cardName: "Desconhecido" })
      .expect(422);
    expect(res.body.error.code).toBe("unmapped_card");
    expect(await prisma.purchase.count()).toBe(0);
  });

  it("suggests the tag last used at the same merchant", async () => {
    const { auth, accountId } = await setup();
    const categoryRes = await request(app).post("/categories").set(auth).send({ name: "Alimentação", color: "#ff0000" }).expect(201);
    await request(app)
      .post("/transactions")
      .set(auth)
      .send({ accountId, type: "diario", amount: "20.00", date: todayIso(), description: "padaria pão quente", categoryId: categoryRes.body.id })
      .expect(201);

    const res = await request(app)
      .post("/quick-entries")
      .set(auth)
      .send({ amount: 26, merchant: "Padaria Pão Quente" })
      .expect(201);
    expect(res.body.categoryName).toBe("Alimentação");
  });

  it("validates the amount and the mapping target", async () => {
    const { auth, accountId, cardIds } = await setup();
    await request(app).post("/quick-entries").set(auth).send({ amount: "0", merchant: "X" }).expect(400);
    await request(app).post("/quick-entries").set(auth).send({ amount: "abc", merchant: "X" }).expect(400);
    await request(app)
      .put("/quick-entries/mappings")
      .set(auth)
      .send({ walletName: "Ambos", cardId: cardIds[0], accountId })
      .expect(400);
  });

  it("lists, updates and deletes mappings, scoped to the user", async () => {
    const { auth, accountId, cardIds } = await setup();
    await request(app).put("/quick-entries/mappings").set(auth).send({ walletName: "Nubank", cardId: cardIds[0] }).expect(200);
    // Same wallet name (normalized) updates instead of duplicating.
    await request(app).put("/quick-entries/mappings").set(auth).send({ walletName: " NUBANK ", accountId }).expect(200);

    const list = await request(app).get("/quick-entries/mappings").set(auth).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ walletName: "nubank", cardId: null, account: { name: "Conta Itaú" } });

    const other = await createTestUser();
    await request(app)
      .delete(`/quick-entries/mappings/${list.body[0].id}`)
      .set("Authorization", `Bearer ${other.token}`)
      .expect(404);
    await request(app).delete(`/quick-entries/mappings/${list.body[0].id}`).set(auth).expect(204);
  });
});
