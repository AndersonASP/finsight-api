import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { env } from "../../src/core/config/env.js";
import { prisma } from "../../src/core/db/prisma.js";
import { cleanupDatabase } from "./helpers.js";

describe("auth", () => {
  afterEach(async () => {
    await cleanupDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function login() {
    const email = `auth-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    await prisma.user.create({ data: { email, passwordHash: await bcrypt.hash("password123", 4) } });
    const res = await request(app).post("/auth/login").send({ email, password: "password123" }).expect(200);
    return res.body as { accessToken: string; refreshToken: string };
  }

  it("refreshes with a tracked refresh token", async () => {
    const { refreshToken } = await login();
    const res = await request(app).post("/auth/refresh").send({ refreshToken }).expect(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
  });

  it("rejects a refresh token after logout", async () => {
    const { refreshToken } = await login();
    await request(app).post("/auth/logout").send({ refreshToken }).expect(204);
    await request(app).post("/auth/refresh").send({ refreshToken }).expect(401);
  });

  it("logout-all revokes every session of the user only", async () => {
    const first = await login();
    const user = await prisma.user.findFirstOrThrow();
    const secondRes = await request(app)
      .post("/auth/login")
      .send({ email: user.email, password: "password123" })
      .expect(200);
    const other = await login();

    await request(app).post("/auth/logout-all").set("Authorization", `Bearer ${first.accessToken}`).expect(204);

    await request(app).post("/auth/refresh").send({ refreshToken: first.refreshToken }).expect(401);
    await request(app).post("/auth/refresh").send({ refreshToken: secondRes.body.refreshToken }).expect(401);
    await request(app).post("/auth/refresh").send({ refreshToken: other.refreshToken }).expect(200);
  });

  it("rejects legacy refresh tokens without a jti", async () => {
    const user = await prisma.user.create({
      data: { email: "legacy@example.com", passwordHash: await bcrypt.hash("password123", 4) },
    });
    const legacy = jwt.sign({ sub: user.id, type: "refresh" }, env.JWT_REFRESH_SECRET, { expiresIn: "30d" });
    await request(app).post("/auth/refresh").send({ refreshToken: legacy }).expect(401);
  });

  it("treats logout with a garbage token as a no-op", async () => {
    await request(app).post("/auth/logout").send({ refreshToken: "not-a-jwt" }).expect(204);
  });
});
