import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { addMonthsIso, cleanupDatabase, createTestUser, todayIso } from "./helpers.js";

describe("reserve loans", () => {
  afterEach(async () => {
    await cleanupDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function setup(reserveInitialBalance = "1000.00") {
    const { token } = await createTestUser();
    const checkingRes = await request(app)
      .post("/accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Conta corrente", type: "checking", initialBalance: "0.00" })
      .expect(201);
    const reserveRes = await request(app)
      .post("/accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Reserva", type: "savings_reserve", initialBalance: reserveInitialBalance })
      .expect(201);

    return { token, checkingId: checkingRes.body.id as string, reserveId: reserveRes.body.id as string };
  }

  it("rejects borrowing more than the reserve's available balance", async () => {
    const { token, checkingId, reserveId } = await setup("500.00");

    const res = await request(app)
      .post("/reserve-loans")
      .set("Authorization", `Bearer ${token}`)
      .send({
        reserveAccountId: reserveId,
        destinationAccountId: checkingId,
        principal: "600.00",
        borrowDate: todayIso(),
      });

    expect(res.status).toBe(400);
  });

  it("rejects a reserve account that isn't type savings_reserve", async () => {
    const { token, checkingId } = await setup();
    const otherCheckingRes = await request(app)
      .post("/accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Outra corrente", type: "checking", initialBalance: "1000.00" })
      .expect(201);

    const res = await request(app)
      .post("/reserve-loans")
      .set("Authorization", `Bearer ${token}`)
      .send({
        reserveAccountId: otherCheckingRes.body.id,
        destinationAccountId: checkingId,
        principal: "100.00",
        borrowDate: todayIso(),
      });

    expect(res.status).toBe(400);
  });

  it("borrowing moves principal between the two accounts' balances", async () => {
    const { token, checkingId, reserveId } = await setup("1000.00");

    await request(app)
      .post("/reserve-loans")
      .set("Authorization", `Bearer ${token}`)
      .send({
        reserveAccountId: reserveId,
        destinationAccountId: checkingId,
        principal: "400.00",
        borrowDate: todayIso(),
      })
      .expect(201);

    const reserveBalance = await request(app)
      .get(`/accounts/${reserveId}/balance`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const checkingBalance = await request(app)
      .get(`/accounts/${checkingId}/balance`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(reserveBalance.body.balance).toBe("600.00");
    expect(checkingBalance.body.balance).toBe("400.00");
  });

  it("a partial repayment one month later pays interest first, then principal, and updates both balances", async () => {
    const { token, checkingId, reserveId } = await setup("1000.00");

    const loanRes = await request(app)
      .post("/reserve-loans")
      .set("Authorization", `Bearer ${token}`)
      .send({
        reserveAccountId: reserveId,
        destinationAccountId: checkingId,
        principal: "1000.00",
        borrowDate: todayIso(),
      })
      .expect(201);
    const loanId = loanRes.body.id as string;

    // One month later: 10% of 1000 = 100 interest owed. Repaying 300 covers
    // all the interest and 200 of principal.
    const repaymentRes = await request(app)
      .post(`/reserve-loans/${loanId}/repayments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ repaymentDate: addMonthsIso(todayIso(), 1), amount: "300.00" })
      .expect(201);

    expect(repaymentRes.body.interestPortion).toBe("100.00");
    expect(repaymentRes.body.principalPortion).toBe("200.00");
    expect(repaymentRes.body.outstandingPrincipalAfter).toBe("800.00");

    const owedRes = await request(app)
      .get(`/reserve-loans/${loanId}/owed`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(owedRes.body.outstandingPrincipal).toBe("800.00");

    // Reserve: started with 1000, lent out 1000 (-> 0), received the 300
    // repayment back (-> 300). Checking: received 1000, paid back 300 (-> 700).
    const reserveBalance = await request(app)
      .get(`/accounts/${reserveId}/balance`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const checkingBalance = await request(app)
      .get(`/accounts/${checkingId}/balance`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(reserveBalance.body.balance).toBe("300.00");
    expect(checkingBalance.body.balance).toBe("700.00");
  });

  it("settles the loan once a repayment covers the full outstanding principal", async () => {
    const { token, checkingId, reserveId } = await setup("1000.00");

    const loanRes = await request(app)
      .post("/reserve-loans")
      .set("Authorization", `Bearer ${token}`)
      .send({
        reserveAccountId: reserveId,
        destinationAccountId: checkingId,
        principal: "1000.00",
        borrowDate: todayIso(),
      })
      .expect(201);
    const loanId = loanRes.body.id as string;

    // Same-day settlement: 0 months elapsed, so 0 interest — the full 1000 is principal.
    await request(app)
      .post(`/reserve-loans/${loanId}/repayments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ repaymentDate: todayIso(), amount: "1000.00" })
      .expect(201);

    const loanDetail = await request(app).get(`/reserve-loans/${loanId}`).set("Authorization", `Bearer ${token}`).expect(200);
    expect(loanDetail.body.loan.status).toBe("settled");
    expect(loanDetail.body.outstandingPrincipal).toBe("0.00");
  });

  it("rejects a repayment larger than what's actually owed", async () => {
    const { token, checkingId, reserveId } = await setup("1000.00");

    const loanRes = await request(app)
      .post("/reserve-loans")
      .set("Authorization", `Bearer ${token}`)
      .send({
        reserveAccountId: reserveId,
        destinationAccountId: checkingId,
        principal: "1000.00",
        borrowDate: todayIso(),
      })
      .expect(201);

    const res = await request(app)
      .post(`/reserve-loans/${loanRes.body.id}/repayments`)
      .set("Authorization", `Bearer ${token}`)
      .send({ repaymentDate: todayIso(), amount: "1000.01" }); // 1 cent over, 0 interest on day 0

    expect(res.status).toBe(400);
  });
});
