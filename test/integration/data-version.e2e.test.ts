import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { cleanupDatabase, createTestUser, todayIso } from "./helpers.js";

describe("data version (refresh signal)", () => {
  afterEach(async () => {
    await cleanupDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const version = async (auth: Record<string, string>) =>
    (await request(app).get("/sync/version").set(auth).expect(200)).body.version as number;

  /** The bump happens right after the response is sent — give it a moment. */
  async function versionAfterWrite(auth: Record<string, string>, previous: number) {
    for (let i = 0; i < 20; i++) {
      const v = await version(auth);
      if (v !== previous) return v;
      await new Promise((r) => setTimeout(r, 25));
    }
    return previous;
  }

  it("moves after writes, not after reads or failed writes, and only for that user", async () => {
    const { token } = await createTestUser();
    const auth = { Authorization: `Bearer ${token}` };
    const other = await createTestUser();
    const otherAuth = { Authorization: `Bearer ${other.token}` };

    const v0 = await version(auth);
    const accountId = (
      await request(app).post("/accounts").set(auth).send({ name: "Conta", type: "checking", initialBalance: "0" }).expect(201)
    ).body.id;
    const v1 = await versionAfterWrite(auth, v0);
    expect(v1).toBeGreaterThan(v0);

    await request(app).get("/accounts").set(auth).expect(200);
    await request(app).post("/transactions").set(auth).send({ accountId, type: "diario" }).expect(400);
    await new Promise((r) => setTimeout(r, 100));
    expect(await version(auth)).toBe(v1);

    const tx = (
      await request(app).post("/transactions").set(auth).send({ accountId, type: "diario", amount: "5.00", date: todayIso() }).expect(201)
    ).body;
    const v2 = await versionAfterWrite(auth, v1);
    expect(v2).toBeGreaterThan(v1);

    await request(app).delete(`/transactions/${tx.id}`).set(auth).expect(204);
    expect(await versionAfterWrite(auth, v2)).toBeGreaterThan(v2);

    expect(await version(otherAuth)).toBe(0);
  });

  it("requires auth", async () => {
    await request(app).get("/sync/version").expect(401);
  });
});
