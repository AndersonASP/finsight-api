import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { cleanupDatabase, createTestUser, todayIso } from "./helpers.js";

describe("wishlist (Quero comprar)", () => {
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
      await request(app).post("/accounts").set(auth).send({ name: "Conta", type: "checking", initialBalance: "0.00" }).expect(201)
    ).body.id as string;
    await request(app)
      .post("/recurring-transactions")
      .set(auth)
      .send({ accountId, type: "entrada", amount: "10000.00", startDate: todayIso(), interval: "monthly", occurrenceCount: 24 })
      .expect(201);
    return { auth };
  }

  it("lists each item with today's simulation, on the same projection", async () => {
    const { auth } = await setup();
    const bike = (await request(app).post("/wishlist").set(auth).send({ description: "Bike", amount: "1000.00" }).expect(201)).body;
    expect(bike).toMatchObject({ description: "Bike", amount: "1000.00", interestFreeInstallments: 1, pixDiscountPercent: null });
    await request(app).post("/wishlist").set(auth).send({ description: "Notebook", amount: "9000.00", pixDiscountPercent: 5 }).expect(201);

    const list = (await request(app).get("/wishlist").set(auth).expect(200)).body;
    expect(list.map((i: { description: string; simulacao: { veredito: string } }) => [i.description, i.simulacao.veredito])).toEqual([
      ["Bike", "cabe"],
      ["Notebook", "fura_reserva"],
    ]);
    expect(list[1].simulacao.decidido).toBe(true);
    expect(list[1].simulacao.caminhos.length).toBeGreaterThan(0);
  });

  it("updates and deletes only the user's own items", async () => {
    const { auth } = await setup();
    const item = (await request(app).post("/wishlist").set(auth).send({ description: "Bike", amount: "1000.00" }).expect(201)).body;
    const updated = (
      await request(app).patch(`/wishlist/${item.id}`).set(auth).send({ amount: "1500.00", interestFreeInstallments: 10 }).expect(200)
    ).body;
    expect(updated).toMatchObject({ amount: "1500.00", interestFreeInstallments: 10 });

    const other = await createTestUser();
    const otherAuth = { Authorization: `Bearer ${other.token}` };
    await request(app).patch(`/wishlist/${item.id}`).set(otherAuth).send({ amount: "1.00" }).expect(404);
    await request(app).delete(`/wishlist/${item.id}`).set(otherAuth).expect(404);

    await request(app).delete(`/wishlist/${item.id}`).set(auth).expect(204);
    expect((await request(app).get("/wishlist").set(auth).expect(200)).body).toEqual([]);
  });

  it("validates the input", async () => {
    const { auth } = await setup();
    await request(app).post("/wishlist").set(auth).send({ description: "", amount: "10.00" }).expect(400);
    await request(app).post("/wishlist").set(auth).send({ description: "X", amount: "0" }).expect(400);
  });
});
