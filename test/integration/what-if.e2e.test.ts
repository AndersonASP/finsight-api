import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/core/db/prisma.js";
import { cleanupDatabase, createTestUser, todayIso } from "./helpers.js";

describe("insights: E se? (what-if)", () => {
  afterEach(async () => {
    await cleanupDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** A checking account and, optionally, a monthly salary from today on (meta 20% = R$ 2.000). */
  async function setup(initialBalance: string, salary?: string) {
    const { token } = await createTestUser();
    const auth = { Authorization: `Bearer ${token}` };
    const accountId = (
      await request(app).post("/accounts").set(auth).send({ name: "Conta", type: "checking", initialBalance }).expect(201)
    ).body.id as string;
    if (salary) {
      await request(app)
        .post("/recurring-transactions")
        .set(auth)
        .send({ accountId, type: "entrada", amount: salary, description: "Salário", startDate: todayIso(), interval: "monthly", occurrenceCount: 24 })
        .expect(201);
    }
    return { auth, accountId };
  }

  async function addCard(auth: Record<string, string>, accountId: string, name = "Nubank") {
    return (await request(app).post("/cards").set(auth).send({ name, closingDay: 1, dueDay: 8, defaultPaymentAccountId: accountId }).expect(201))
      .body.id as string;
  }

  const whatIf = (auth: Record<string, string>, body: Record<string, unknown>, status = 200) =>
    request(app).post("/insights/what-if").set(auth).send(body).expect(status);

  async function rowCounts() {
    return Promise.all([prisma.purchase.count(), prisma.installment.count(), prisma.transaction.count(), prisma.invoice.count()]);
  }

  it("cabe: keeps the savings target, explains it in plain text and saves nothing", async () => {
    const { auth } = await setup("5000.00", "10000.00");
    const before = await rowCounts();

    const res = (await whatIf(auth, { description: "Bike", amount: "1000.00", payment: { method: "pix" } })).body;
    expect(res.veredito).toBe("cabe");
    expect(res.manchete).toBe("Pode comprar no Pix/débito.");
    expect(res.motivos.some((m: string) => m.startsWith("Você ainda guarda"))).toBe(true);
    expect(res.motivos.at(-1)).toBe("Equivale a 10% da sua entrada do mês.");
    expect(res.escolhida).toMatchObject({ forma: "pix", valorTotal: "1000.00", dataDaCompra: todayIso() });
    expect(res.reserva).toMatchObject({ vemPrimeiro: true, completa: false });
    expect(res.metaPercent).toBe("20");
    expect(res.simulado).toBe(true);

    expect(await rowCounts()).toEqual(before);
  });

  it("fura a reserva: the saldo holds but savings fall under the target, with paths that respect it", async () => {
    const { auth, accountId } = await setup("0.00", "10000.00");
    await addCard(auth, accountId);

    const res = (await whatIf(auth, { amount: "9000.00", payment: { method: "pix" }, interestFreeInstallments: 3 })).body;
    expect(res.veredito).toBe("fura_reserva");
    expect(res.manchete).toBe("Dá para pagar, mas fura sua reserva.");
    expect(res.motivos[0]).toMatch(/você guardaria 10% em vez de 20% \(R\$ [\d.]+ a menos\)\./);
    expect(res.motivos[1]).toBe("Você ainda não tem reserva de emergência medida: ela vem antes.");
    expect(res.caminhos[0]).toBe("No Nubank em 2x de R$ 4.500 cabe sem furar a reserva.");
    expect(res.caminhos.at(-1)).toMatch(/^Ou junte para ela: R\$ [\d.]+\/mês além da sua meta, pronta em /);
    expect(res.alternativa).toMatchObject({ forma: "cartao", parcelas: 2, veredito: "cabe" });
    // The margin above the target already pays the installments: nothing missing, only the paths.
    expect(res.plano).toBeNull();
  });

  it("me ajuda a decidir: picks the fewest installments that fit and compares with Pix", async () => {
    const { auth, accountId } = await setup("0.00", "10000.00");
    await addCard(auth, accountId);

    const res = (await whatIf(auth, { amount: "9000.00", interestFreeInstallments: 3 })).body;
    expect(res.decidido).toBe(true);
    expect(res.veredito).toBe("cabe");
    expect(res.escolhida).toMatchObject({ forma: "cartao", nome: "Nubank", parcelas: 2 });
    expect(res.manchete).toBe("Pode comprar. Melhor no Nubank em 2x de R$ 4.500.");
    expect(res.opcoes.map((o: { forma: string; veredito: string }) => [o.forma, o.veredito])).toEqual([
      ["cartao", "cabe"],
      ["pix", "fura_reserva"],
    ]);
  });

  it("não cabe when the saldo would go negative", async () => {
    const { auth } = await setup("100.00");
    const res = (await whatIf(auth, { amount: "500.00", payment: { method: "pix" } })).body;
    expect(res.veredito).toBe("nao_cabe");
    expect(res.manchete).toBe("Agora não cabe.");
    expect(res.motivos[0]).toMatch(/^Seu saldo fica negativo em .+ \(até R\$ -400 em \d+\/\w+\)\.$/);
    // No card to split it: the plan saves up for 6 months before paying by Pix.
    expect(res.plano).toMatchObject({ buraco: null, ajusteMensal: "0.00", compraPorMes: "84.00", meses: 6 });
    expect(res.plano.linhas).toEqual(["Para a compra: juntar R$ 84/mês por 6 meses antes e pagar no Pix."]);
  });

  it("recurring: a monthly charge over 12 months", async () => {
    const { auth } = await setup("5000.00", "10000.00");
    const res = (await whatIf(auth, { description: "Academia", amount: "120.00", recurring: true, payment: { method: "pix" } })).body;
    expect(res.recorrente).toBe(true);
    expect(res.veredito).toBe("cabe");
    expect(res.manchete).toBe("Cabe no seu mês.");
    expect(res.escolhida.vencimentos).toHaveLength(12);
    expect(res.motivos.at(-1)).toBe("São R$ 1.440 em 12 meses; por mês, equivale a 1% da sua entrada do mês.");
  });

  it("validates the input", async () => {
    const { auth } = await setup("1000.00");
    await whatIf(auth, { amount: "0" }, 400);
    await whatIf(auth, { amount: "10.00", pixDiscountPercent: 90 }, 400);
    const other = await setup("0");
    const foreignCard = await addCard(other.auth, other.accountId, "X");
    await whatIf(auth, { amount: "10.00", payment: { method: "card", cardId: foreignCard, installments: 1 } }, 404);
  });
});
