import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { cleanupDatabase, createTestUser, futureYearMonth, todayIso } from "./helpers.js";

describe("daily-balance's diário forecast (previsão de diário)", () => {
  afterEach(async () => {
    await cleanupDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("projects the monthly average into future days with no real activity, and a real transaction overrides it", async () => {
    const { token } = await createTestUser();
    const accountRes = await request(app)
      .post("/accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Conta", type: "checking", initialBalance: "1000.00" })
      .expect(201);
    const accountId = accountRes.body.id as string;

    const { year, month } = futureYearMonth(1); // entirely in the future, so every day qualifies
    const daysInTargetMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const pad = (n: number) => String(n).padStart(2, "0");

    await request(app)
      .post("/budget-items")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Barbeiro", amount: (daysInTargetMonth * 10).toFixed(2) }) // -> dailyAverage = 10.00
      .expect(201);

    // A real transaction on day 15 wins over the projection — no double-counting.
    await request(app)
      .post("/transactions")
      .set("Authorization", `Bearer ${token}`)
      .send({ accountId, type: "diario", amount: "37.00", date: `${year}-${pad(month)}-15` })
      .expect(201);

    const res = await request(app)
      .get(`/reports/daily-balance?year=${year}&month=${month}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const day1 = res.body.find((d: { day: number }) => d.day === 1);
    const day15 = res.body.find((d: { day: number }) => d.day === 15);

    expect(day1.diario).toBe("10.00");
    expect(day1.diarioIsForecast).toBe(true);

    expect(day15.diario).toBe("37.00"); // real transaction, not 10 + 37
    expect(day15.diarioIsForecast).toBe(false);
    // Days 2-14 (13 days) are each forecasted at 10.00, plus day 15's real 37 —
    // the gap between day1's and day15's saldo is exactly that, regardless of
    // the (real-time-dependent) anchor value itself.
    expect(Number(day1.saldo) - Number(day15.saldo)).toBeCloseTo(10 * 13 + 37, 2);
  });

  it("today's diário stays at zero (not the forecast), even with an active previsão", async () => {
    const { token } = await createTestUser();
    await request(app)
      .post("/accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Conta", type: "checking", initialBalance: "500.00" })
      .expect(201);
    await request(app)
      .post("/budget-items")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Barbeiro", amount: "300.00" })
      .expect(201);

    const now = new Date();
    const res = await request(app)
      .get(`/reports/daily-balance?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const todayEntry = res.body.find((d: { date: string }) => d.date === todayIso());
    expect(todayEntry.diario).toBe("0.00");
    expect(todayEntry.diarioIsForecast).toBe(false);
  });

  it("does not project anything when there is no active budget item", async () => {
    const { token } = await createTestUser();
    await request(app)
      .post("/accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Conta", type: "checking", initialBalance: "500.00" })
      .expect(201);

    const { year, month } = futureYearMonth(1);
    const res = await request(app)
      .get(`/reports/daily-balance?year=${year}&month=${month}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body.every((d: { diarioIsForecast: boolean }) => d.diarioIsForecast === false)).toBe(true);
  });

  it("saldo carries over continuously across a month boundary instead of snapping back to reality", async () => {
    const { token } = await createTestUser();
    await request(app)
      .post("/accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Conta", type: "checking", initialBalance: "1000.00" })
      .expect(201);
    await request(app)
      .post("/budget-items")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Barbeiro", amount: "300.00" })
      .expect(201);

    const now = new Date();
    const currentMonthRes = await request(app)
      .get(`/reports/daily-balance?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const { year: nextYear, month: nextMonth } = futureYearMonth(1);
    const nextMonthRes = await request(app)
      .get(`/reports/daily-balance?year=${nextYear}&month=${nextMonth}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const lastDayOfCurrentMonth = currentMonthRes.body.at(-1);
    const day1OfNextMonth = nextMonthRes.body[0];

    // Day 1 of next month must continue exactly from where the current
    // month's last (forecasted) day left off, minus its own day's forecast —
    // not jump back up to the real, non-forecasted balance.
    expect(Number(day1OfNextMonth.saldo)).toBeCloseTo(
      Number(lastDayOfCurrentMonth.saldo) - Number(day1OfNextMonth.diario),
      2
    );
  });

  it("does not project when viewing a single account's daily balance (budget items aren't tied to an account)", async () => {
    const { token } = await createTestUser();
    const accountRes = await request(app)
      .post("/accounts")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Conta", type: "checking", initialBalance: "500.00" })
      .expect(201);
    await request(app)
      .post("/budget-items")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Barbeiro", amount: "300.00" })
      .expect(201);

    const { year, month } = futureYearMonth(1);
    const res = await request(app)
      .get(`/reports/daily-balance?year=${year}&month=${month}&accountId=${accountRes.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body.every((d: { diarioIsForecast: boolean }) => d.diarioIsForecast === false)).toBe(true);
  });
});
