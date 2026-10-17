import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { addMonthsIso, cleanupDatabase, createTestUser, todayIso } from "./helpers.js";

describe("bills (contas a pagar)", () => {
  afterEach(async () => {
    await cleanupDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function setup() {
    const { token } = await createTestUser();
    const auth = { Authorization: `Bearer ${token}` };
    const accountRes = await request(app)
      .post("/accounts")
      .set(auth)
      .send({ name: "Conta", type: "checking", initialBalance: "5000.00" })
      .expect(201);
    const accountId = accountRes.body.id as string;

    const start = addMonthsIso(todayIso(), 1);
    await request(app)
      .post("/recurring-transactions")
      .set(auth)
      .send({ accountId, type: "saida", amount: "1500.00", description: "Aluguel", startDate: start, interval: "monthly", occurrenceCount: 3 })
      .expect(201);
    // A one-off saída and a recurring entrada must not show up as bills.
    await request(app).post("/transactions").set(auth).send({ accountId, type: "saida", amount: "50.00", date: start }).expect(201);
    await request(app)
      .post("/recurring-transactions")
      .set(auth)
      .send({ accountId, type: "entrada", amount: "8000.00", startDate: start, interval: "monthly", occurrenceCount: 3 })
      .expect(201);

    const cardRes = await request(app)
      .post("/cards")
      .set(auth)
      .send({ name: "Nubank", closingDay: 10, dueDay: 17, defaultPaymentAccountId: accountId })
      .expect(201);
    await request(app)
      .post("/purchases")
      .set(auth)
      .send({ cardId: cardRes.body.id, purchaseDate: start, description: "Mercado", amount: "150.00" })
      .expect(201);

    return { auth, start };
  }

  async function listBills(auth: Record<string, string>, start: string) {
    const res = await request(app)
      .get(`/bills?from=${start}&to=${addMonthsIso(start, 3)}`)
      .set(auth)
      .expect(200);
    return res.body as { kind: string; id: string; description: string; amount: string; dueDate: string; paid: boolean }[];
  }

  it("lists recurring saídas and non-empty invoices, sorted by due date", async () => {
    const { auth, start } = await setup();
    const bills = await listBills(auth, start);

    const saidas = bills.filter((b) => b.kind === "recurring_saida");
    expect(saidas).toHaveLength(3);
    expect(saidas.every((b) => b.description === "Aluguel" && b.amount === "1500.00" && !b.paid)).toBe(true);

    const invoices = bills.filter((b) => b.kind === "invoice");
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ description: "Fatura Nubank", amount: "150.00", paid: false });

    const dates = bills.map((b) => b.dueDate);
    expect(dates).toEqual([...dates].sort());
  });

  it("toggles the paid check on a transaction and an invoice", async () => {
    const { auth, start } = await setup();
    const [saida] = (await listBills(auth, start)).filter((b) => b.kind === "recurring_saida");
    const [invoice] = (await listBills(auth, start)).filter((b) => b.kind === "invoice");

    await request(app).patch(`/transactions/${saida.id}/paid`).set(auth).send({ paid: true }).expect(200);
    await request(app).patch(`/invoices/${invoice.id}/paid`).set(auth).send({ paid: true }).expect(200);

    let bills = await listBills(auth, start);
    expect(bills.find((b) => b.id === saida.id)?.paid).toBe(true);
    expect(bills.find((b) => b.id === invoice.id)?.paid).toBe(true);

    await request(app).patch(`/transactions/${saida.id}/paid`).set(auth).send({ paid: false }).expect(200);
    bills = await listBills(auth, start);
    expect(bills.find((b) => b.id === saida.id)?.paid).toBe(false);
  });

  it("does not change balances when a bill is checked as paid", async () => {
    const { auth, start } = await setup();
    const [year, month] = start.split("-").map(Number);
    const balanceUrl = `/reports/daily-balance?year=${year}&month=${month}`;

    const before = await request(app).get(balanceUrl).set(auth).expect(200);
    for (const bill of await listBills(auth, start)) {
      const path = bill.kind === "invoice" ? "invoices" : "transactions";
      await request(app).patch(`/${path}/${bill.id}/paid`).set(auth).send({ paid: true }).expect(200);
    }
    const after = await request(app).get(balanceUrl).set(auth).expect(200);

    expect(after.body).toEqual(before.body);
  });

  it("does not let a user check another user's bill", async () => {
    const { auth, start } = await setup();
    const [saida] = await listBills(auth, start);
    const other = await createTestUser();
    await request(app)
      .patch(`/transactions/${saida.id}/paid`)
      .set("Authorization", `Bearer ${other.token}`)
      .send({ paid: true })
      .expect(404);
  });

  it("requires from and to", async () => {
    const { auth } = await setup();
    await request(app).get("/bills").set(auth).expect(400);
  });
});
