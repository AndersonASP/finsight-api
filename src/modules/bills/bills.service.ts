import { Prisma } from "@prisma/client";
import { prisma } from "../../core/db/prisma.js";

export type BillKind = "recurring_saida" | "invoice";

export interface Bill {
  kind: BillKind;
  id: string;
  description: string;
  amount: Prisma.Decimal;
  dueDate: Date;
  paid: boolean;
  paidAt: Date | null;
}

/**
 * The "contas a pagar" checklist: fixed (recurring) saídas and card invoices
 * due within [from, to]. The paid flag here is purely a visual check — none
 * of the balance/projection code reads it.
 */
export async function listBills(userId: string, from: Date, to: Date): Promise<Bill[]> {
  const [transactions, invoices] = await Promise.all([
    prisma.transaction.findMany({
      where: { userId, type: "saida", recurringTransactionId: { not: null }, date: { gte: from, lte: to } },
      include: { category: true },
    }),
    prisma.invoice.findMany({
      where: { userId, dueDate: { gte: from, lte: to } },
      include: { card: true, installments: { select: { amount: true } } },
    }),
  ]);

  const bills: Bill[] = [
    ...transactions.map((t) => ({
      kind: "recurring_saida" as const,
      id: t.id,
      description: t.description || t.category?.name || "Saída fixa",
      amount: t.amount,
      dueDate: t.date,
      paid: t.paidAt !== null,
      paidAt: t.paidAt,
    })),
    ...invoices
      .map((invoice) => ({
        invoice,
        total: invoice.installments.reduce((sum, i) => sum.plus(i.amount), new Prisma.Decimal(0)),
      }))
      // An invoice with nothing on it isn't something to pay.
      .filter(({ total }) => total.greaterThan(0))
      .map(({ invoice, total }) => ({
        kind: "invoice" as const,
        id: invoice.id,
        description: `Fatura ${invoice.card.name}`,
        amount: total,
        dueDate: invoice.dueDate,
        paid: invoice.paidAt !== null,
        paidAt: invoice.paidAt,
      })),
  ];

  return bills.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime() || a.description.localeCompare(b.description));
}
