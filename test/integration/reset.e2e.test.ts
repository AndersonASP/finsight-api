import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { cleanupDatabase, createTestUser, todayIso } from "./helpers.js";

describe("POST /reset — reiniciar o projeto", () => {
  afterEach(async () => {
    await cleanupDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("wipes every lançamento/conta/cartão/dívida and recreates the two default accounts", async () => {
    const { token } = await createTestUser();

    const account = await request(app)
      .post("/accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Velha", type: "checking", initialBalance: "500.00" })
      .expect(201);
    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId: account.body.id, type: "diario", amount: "50.00", date: todayIso() })
      .expect(201);
    await request(app)
      .post("/categories")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Mercado", color: "#ff0000" })
      .expect(201);
    await request(app)
      .post("/debts")
      .set("Authorization", `Bearer ${token}`)
      .send({ creditor: "Banco X", type: "outro", currentBalance: "100.00" })
      .expect(201);

    const res = await request(app).post("/reset").set("Authorization", `Bearer ${token}`).expect(200);
    const resetAccounts = res.body.accounts as Array<{ name: string; type: string; initialBalance: string }>;
    expect(resetAccounts).toHaveLength(2);
    expect(resetAccounts.map((a) => a.name).sort()).toEqual(["Conta corrente", "Reserva de emergência"].sort());
    expect(resetAccounts.find((a) => a.type === "checking")).toBeDefined();
    expect(resetAccounts.find((a) => a.type === "savings_reserve")).toBeDefined();

    const accountsRes = await request(app).get("/accounts").set("Authorization", `Bearer ${token}`).expect(200);
    expect(accountsRes.body).toHaveLength(2);
    expect(accountsRes.body.some((a: { name: string }) => a.name === "Velha")).toBe(false);

    const transactionsRes = await request(app).get("/transactions").set("Authorization", `Bearer ${token}`).expect(200);
    expect(transactionsRes.body).toHaveLength(0);

    const categoriesRes = await request(app).get("/categories").set("Authorization", `Bearer ${token}`).expect(200);
    expect(categoriesRes.body).toHaveLength(0);

    const debtsRes = await request(app).get("/debts").set("Authorization", `Bearer ${token}`).expect(200);
    expect(debtsRes.body).toHaveLength(0);
  });

  it("does not affect another user's data", async () => {
    const { token: tokenA } = await createTestUser();
    const { token: tokenB } = await createTestUser();

    await request(app)
      .post("/accounts")
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ name: "Da Beatriz", type: "checking", initialBalance: "999.00" })
      .expect(201);

    await request(app).post("/reset").set("Authorization", `Bearer ${tokenA}`).expect(200);

    const bAccounts = await request(app).get("/accounts").set("Authorization", `Bearer ${tokenB}`).expect(200);
    expect(bAccounts.body).toHaveLength(1);
    expect(bAccounts.body[0].name).toBe("Da Beatriz");
  });
});
