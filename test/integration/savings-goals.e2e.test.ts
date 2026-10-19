import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { cleanupDatabase, createTestUser } from "./helpers.js";

describe("savings goals (RF-14)", () => {
  afterEach(async () => {
    await cleanupDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creating a goal validates the target percent and period", async () => {
    const { token } = await createTestUser();
    const tooHigh = await request(app)
      .post("/savings-goals")
      .set("Authorization", `Bearer ${token}`)
      .send({ periodType: "monthly", periodYear: 2026, periodMonth: 8, targetPercent: "150" });
    expect(tooHigh.status).toBe(400);

    const ok = await request(app)
      .post("/savings-goals")
      .set("Authorization", `Bearer ${token}`)
      .send({ periodType: "monthly", periodYear: 2026, periodMonth: 8, targetPercent: "25" })
      .expect(201);
    expect(ok.body.targetPercent).toBe("25.00");
  });

  it("a transfer to reserve reduces free cash without reducing total patrimony, and is tracked separately", async () => {
    const { token } = await createTestUser();
    const checking = await request(app)
      .post("/accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Conta", type: "checking", initialBalance: "0" })
      .expect(201);
    const reserve = await request(app)
      .post("/accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Reserva", type: "savings_reserve" })
      .expect(201);

    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId: checking.body.id, type: "entrada", amount: "1000.00", date: "2026-08-01" })
      .expect(201);
    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({
        accountId: checking.body.id,
        counterpartAccountId: reserve.body.id,
        type: "economia",
        amount: "300.00",
        date: "2026-08-05",
      })
      .expect(201);

    const goal = await request(app)
      .post("/savings-goals")
      .set("Authorization", `Bearer ${token}`)
      .send({ periodType: "monthly", periodYear: 2026, periodMonth: 8, targetPercent: "20" })
      .expect(201);

    const progress = await request(app)
      .get(`/savings-goals/${goal.body.id}/progress`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(progress.body.cashSavingsAmount).toBe("300.00");
    expect(progress.body.transferToReserveAmount).toBe("300.00"); // fully attributed as a reserve transfer
    expect(progress.body.realizedPercent).toBe("30.00"); // 300 / 1000

    // "Dinheiro livre" (checking) dropped by 300, but total patrimony (checking + reserve) is unchanged.
    const checkingBalance = await request(app)
      .get(`/accounts/${checking.body.id}/balance`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const reserveBalance = await request(app)
      .get(`/accounts/${reserve.body.id}/balance`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(checkingBalance.body.balance).toBe("700.00");
    expect(Number(checkingBalance.body.balance) + Number(reserveBalance.body.balance)).toBe(1000);
  });

  it("distinguishes patrimonio variation (investment snapshots) from cash savings, never mixing it into the percentage", async () => {
    const { token } = await createTestUser();
    const checking = await request(app)
      .post("/accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Conta", type: "checking" })
      .expect(201);
    const investment = await request(app)
      .post("/accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Investimentos", type: "investment", initialBalance: "5000.00" })
      .expect(201);

    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId: checking.body.id, type: "entrada", amount: "1000.00", date: "2026-09-01" })
      .expect(201);
    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId: checking.body.id, counterpartAccountId: investment.body.id, type: "economia", amount: "100.00", date: "2026-09-03" })
      .expect(201);

    // Investment account gained R$500 in market value this month (no transaction involved).
    await request(app)
      .post(`/accounts/${investment.body.id}/balance-snapshots`)
      .set("Authorization", `Bearer ${token}`)
      .send({ snapshotDate: "2026-09-30", balance: "5500.00" })
      .expect(201);

    const goal = await request(app)
      .post("/savings-goals")
      .set("Authorization", `Bearer ${token}`)
      .send({ periodType: "monthly", periodYear: 2026, periodMonth: 9, targetPercent: "20" })
      .expect(201);

    const progress = await request(app)
      .get(`/savings-goals/${goal.body.id}/progress`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(progress.body.patrimonioVariationAmount).toBe("500.00");
    expect(progress.body.realizedPercent).toBe("10.00"); // 100 / 1000 — the R$500 gain never enters this ratio
  });
});
