import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { cleanupDatabase, createTestUser, futureYearMonth, todayIso } from "./helpers.js";

describe("ledger (accounts, transactions, reports)", () => {
  afterEach(async () => {
    await cleanupDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createAccount(token: string, body: Record<string, unknown>) {
    const res = await request(app).post("/accounts").set("Authorization", `Bearer ${token}`).send(body);
    expect(res.status).toBe(201);
    return res.body as { id: string };
  }

  it("computes account balance from entrada/saida/diario transactions", async () => {
    const { token } = await createTestUser();
    const account = await createAccount(token, { name: "Conta", type: "checking", initialBalance: "1000.00" });

    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId: account.id, type: "entrada", amount: "500.00", date: "2026-01-05" })
      .expect(201);

    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId: account.id, type: "saida", amount: "200.00", date: "2026-01-06" })
      .expect(201);

    const balanceRes = await request(app)
      .get(`/accounts/${account.id}/balance`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(balanceRes.body.balance).toBe("1300.00"); // 1000 + 500 - 200
  });

  it("a new account's initial balance does not bleed into dates before the account existed", async () => {
    const { token } = await createTestUser();
    const account = await createAccount(token, { name: "Conta", type: "checking", initialBalance: "500.00" });

    const pastBalance = await request(app)
      .get(`/accounts/${account.id}/balance`)
      .query({ date: "2000-01-01" })
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(pastBalance.body.balance).toBe("0.00");

    const currentBalance = await request(app)
      .get(`/accounts/${account.id}/balance`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(currentBalance.body.balance).toBe("500.00");
  });

  it("daily-balance shows an account's initialBalance starting exactly on its creation day, within the viewed month", async () => {
    const { token } = await createTestUser();
    await createAccount(token, { name: "Conta", type: "checking", initialBalance: "500.00" });
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const createdDay = now.getUTCDate();

    const res = await request(app)
      .get(`/reports/daily-balance?year=${year}&month=${month}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const dayBefore = res.body.find((d: { day: number }) => d.day === createdDay - 1);
    const creationDay = res.body.find((d: { day: number }) => d.day === createdDay);

    if (dayBefore) expect(dayBefore.saldo).toBe("0.00"); // account didn't exist yet
    expect(creationDay.saldo).toBe("500.00"); // appears exactly on creation day, not before
  });

  it("a transfer to reserve reduces free cash but not total patrimony (RF-14)", async () => {
    const { token } = await createTestUser();
    const checking = await createAccount(token, { name: "Conta", type: "checking", initialBalance: "1000.00" });
    const reserve = await createAccount(token, { name: "Reserva", type: "savings_reserve", initialBalance: "0.00" });

    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        accountId: checking.id,
        counterpartAccountId: reserve.id,
        type: "economia",
        amount: "300.00",
        date: "2026-01-10",
      })
      .expect(201);

    const checkingBalance = await request(app)
      .get(`/accounts/${checking.id}/balance`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const reserveBalance = await request(app)
      .get(`/accounts/${reserve.id}/balance`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(checkingBalance.body.balance).toBe("700.00"); // dinheiro livre reduced
    expect(reserveBalance.body.balance).toBe("300.00");
    const totalPatrimony = Number(checkingBalance.body.balance) + Number(reserveBalance.body.balance);
    expect(totalPatrimony).toBe(1000); // patrimônio total unchanged
  });

  it("rejects a counterpartAccountId on a non-economia transaction", async () => {
    const { token } = await createTestUser();
    const a = await createAccount(token, { name: "A", type: "checking" });
    const b = await createAccount(token, { name: "B", type: "cash" });

    const res = await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId: a.id, counterpartAccountId: b.id, type: "saida", amount: "10.00", date: "2026-01-01" });

    expect(res.status).toBe(400);
  });

  it("economia needs a reserva or investimento destination, so the money never leaves the patrimônio", async () => {
    const { token } = await createTestUser();
    const checking = await createAccount(token, { name: "Conta", type: "checking", initialBalance: "1000.00" });
    const other = await createAccount(token, { name: "Outra", type: "checking" });
    const investment = await createAccount(token, { name: "Corretora", type: "investment" });
    const send = (body: Record<string, unknown>) =>
      request(app)
        .post("/transactions")
        .set("Authorization", `Bearer ${token}`)
        .send({ accountId: checking.id, amount: "100.00", date: "2026-01-10", ...body });

    expect((await send({ type: "economia" })).status).toBe(400); // no destination
    expect((await send({ type: "economia", counterpartAccountId: other.id })).status).toBe(400); // not a saving
    expect((await send({ type: "transferencia" })).status).toBe(400);
    await send({ type: "economia", counterpartAccountId: investment.id }).expect(201); // aporte

    const balance = await request(app)
      .get(`/accounts/${investment.id}/balance`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(balance.body.balance).toBe("100.00");
  });

  it("a resgate da reserva (transferencia) refills the checking saldo without counting as economia or cost", async () => {
    const { token } = await createTestUser();
    const checking = await createAccount(token, { name: "Conta", type: "checking", initialBalance: "1000.00" });
    const reserve = await createAccount(token, { name: "Reserva", type: "savings_reserve", initialBalance: "500.00" });
    const { year, month } = futureYearMonth(1);
    const mm = String(month).padStart(2, "0");

    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId: reserve.id, counterpartAccountId: checking.id, type: "transferencia", amount: "300.00", date: `${year}-${mm}-10` })
      .expect(201);

    const days = await request(app)
      .get(`/reports/daily-balance?year=${year}&month=${month}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const day10 = days.body.find((d: { day: number }) => d.day === 10);
    expect(day10.saldo).toBe("1300.00");
    expect(day10.economia).toBe("0.00");

    const totals = await request(app)
      .get(`/reports/monthly-totals?year=${year}&month=${month}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(totals.body.economia).toBe("0.00");
    expect(totals.body.saidas).toBe("0.00");
  });

  it("daily-balance's saldo nets a transferencia between two checking accounts to zero", async () => {
    const { token } = await createTestUser();
    const checkingA = await createAccount(token, { name: "Conta A", type: "checking", initialBalance: "1000.00" });
    const checkingB = await createAccount(token, { name: "Conta B", type: "checking" });
    const { year, month } = futureYearMonth(1);

    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        accountId: checkingA.id,
        counterpartAccountId: checkingB.id,
        type: "transferencia",
        amount: "150.00",
        date: `${year}-${String(month).padStart(2, "0")}-10`,
      })
      .expect(201);

    const res = await request(app)
      .get(`/reports/daily-balance?year=${year}&month=${month}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const day10 = res.body.find((d: { day: number }) => d.day === 10);
    const day9 = res.body.find((d: { day: number }) => d.day === 9);

    expect(day10.economia).toBe("0.00"); // a transferencia is not saving
    expect(day10.saldo).toBe(day9.saldo); // moved within the checking pool, saldo unchanged
    expect(day10.saldo).toBe("1000.00");
  });

  it("daily-balance's saldo only consolidates checking accounts — a transfer to reserve reduces it", async () => {
    const { token } = await createTestUser();
    const checking = await createAccount(token, { name: "Conta", type: "checking", initialBalance: "1000.00" });
    const reserve = await createAccount(token, { name: "Reserva", type: "savings_reserve" });
    const investment = await createAccount(token, { name: "Investimentos", type: "investment", initialBalance: "5000.00" });
    const cash = await createAccount(token, { name: "Carteira", type: "cash", initialBalance: "80.00" });
    const { year, month } = futureYearMonth(1);

    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        accountId: checking.id,
        counterpartAccountId: reserve.id,
        type: "economia",
        amount: "150.00",
        date: `${year}-${String(month).padStart(2, "0")}-10`,
      })
      .expect(201);

    const res = await request(app)
      .get(`/reports/daily-balance?year=${year}&month=${month}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const day10 = res.body.find((d: { day: number }) => d.day === 10);
    const day9 = res.body.find((d: { day: number }) => d.day === 9);

    expect(day10.economia).toBe("150.00"); // still shown as activity
    expect(day9.saldo).toBe("1000.00"); // investment (5000) and cash (80) never counted
    expect(day10.saldo).toBe("850.00"); // left the checking pool -> saldo drops

    const totalRes = await request(app)
      .get(`/reports/daily-balance?year=${year}&month=${month}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(totalRes.body.at(-1).saldo).toBe("850.00"); // stays reduced for the rest of the month
  });

  it("consolidates three or more checking accounts together in saldo", async () => {
    const { token } = await createTestUser();
    await createAccount(token, { name: "A", type: "checking", initialBalance: "100.00" });
    await createAccount(token, { name: "B", type: "checking", initialBalance: "200.00" });
    await createAccount(token, { name: "C", type: "checking", initialBalance: "300.00" });
    await createAccount(token, { name: "Reserva", type: "savings_reserve", initialBalance: "9999.00" });
    const { year, month } = futureYearMonth(1);

    const res = await request(app)
      .get(`/reports/daily-balance?year=${year}&month=${month}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body[0].saldo).toBe("600.00"); // 100 + 200 + 300, reserve excluded
  });

  it("monthly-totals computes performance, custo de vida and economizado percent", async () => {
    const { token } = await createTestUser();
    const account = await createAccount(token, { name: "Conta", type: "checking" });
    const reserve = await createAccount(token, { name: "Reserva", type: "savings_reserve" });

    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId: account.id, type: "entrada", amount: "1000.00", date: "2026-05-01" })
      .expect(201);
    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId: account.id, type: "diario", amount: "100.00", date: "2026-05-02" })
      .expect(201);
    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId: account.id, counterpartAccountId: reserve.id, type: "economia", amount: "200.00", date: "2026-05-03" })
      .expect(201);

    const res = await request(app)
      .get("/reports/monthly-totals?year=2026&month=5")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body.entradas).toBe("1000.00");
    expect(res.body.performance).toBe("700.00"); // 1000 - 100 - 200
    expect(res.body.custoDeVida).toBe("100.00"); // custo de vida puro: economia is kept, not spent
    expect(res.body.economizadoPercent).toBe("20.00"); // 200 / 1000
  });

  it("daily-balance's saldo reflects a debt payment on the day it happens, not just next month", async () => {
    const { token } = await createTestUser();
    const account = await createAccount(token, { name: "Conta", type: "checking", initialBalance: "1000.00" });
    const debtRes = await request(app)
      .post("/debts")
      .set("Authorization", `Bearer ${token}`)
      .send({ creditor: "Banco X", type: "outro", currentBalance: "500.00" })
      .expect(201);

    await request(app)
      .post(`/debts/${debtRes.body.id}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId: account.id, amount: "200.00", paymentDate: todayIso() })
      .expect(201);

    const now = new Date();
    const res = await request(app)
      .get(`/reports/daily-balance?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const todayEntry = res.body.find((d: { date: string }) => d.date === todayIso());
    expect(todayEntry.saldo).toBe("800.00"); // 1000 - 200, reflected the same day
  });

  it("daily-balance's saldo reflects a reserve-loan borrow on the day it happens, not just next month", async () => {
    const { token } = await createTestUser();
    const checking = await createAccount(token, { name: "Conta", type: "checking", initialBalance: "0.00" });
    const reserve = await createAccount(token, { name: "Reserva", type: "savings_reserve", initialBalance: "1000.00" });

    await request(app)
      .post("/reserve-loans")
      .set("Authorization", `Bearer ${token}`)
      .send({
        reserveAccountId: reserve.id,
        destinationAccountId: checking.id,
        principal: "400.00",
        borrowDate: todayIso(),
      })
      .expect(201);

    const now = new Date();
    const res = await request(app)
      .get(`/reports/daily-balance?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const todayEntry = res.body.find((d: { date: string }) => d.date === todayIso());
    expect(todayEntry.saldo).toBe("400.00"); // borrowed principal arrived in the checking pool today
  });

  it("rejects requests without a bearer token", async () => {
    await request(app).get("/accounts").expect(401);
  });
});
