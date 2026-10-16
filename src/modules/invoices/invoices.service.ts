import { Prisma, type InvoiceStatus } from "@prisma/client";
import { prisma } from "../../core/db/prisma.js";
import { AppError } from "../../core/http/errors.js";

/**
 * Lazily flips `open` -> `closed` once the closing date has passed, instead of
 * relying on a scheduled job — status is always correct whenever read, never
 * stale between job runs.
 */
async function withUpToDateStatus<T extends { id: string; status: InvoiceStatus; closingDate: Date }>(
  invoice: T
): Promise<T> {
  if (invoice.status === "open" && new Date() >= invoice.closingDate) {
    const updated = await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "closed" } });
    return { ...invoice, status: updated.status };
  }
  return invoice;
}

async function getOwnedInvoice(userId: string, invoiceId: string) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice || invoice.userId !== userId) throw AppError.notFound("Invoice not found");
  return withUpToDateStatus(invoice);
}

async function computeTotals(invoiceId: string) {
  const [installmentsTotal, paymentsTotal] = await Promise.all([
    prisma.installment.aggregate({ _sum: { amount: true }, where: { invoiceId } }),
    prisma.invoicePayment.aggregate({ _sum: { amount: true }, where: { invoiceId } }),
  ]);
  const total = new Prisma.Decimal(installmentsTotal._sum.amount ?? 0);
  const paid = new Prisma.Decimal(paymentsTotal._sum.amount ?? 0);
  return { total: total.toFixed(2), paid: paid.toFixed(2), remaining: total.minus(paid).toFixed(2) };
}

export async function listInvoices(userId: string, filter: { cardId?: string; status?: InvoiceStatus }) {
  const invoices = await prisma.invoice.findMany({
    where: { userId, ...(filter.cardId ? { cardId: filter.cardId } : {}), ...(filter.status ? { status: filter.status } : {}) },
    orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
  });

  const upToDate = await Promise.all(invoices.map(withUpToDateStatus));
  return Promise.all(
    upToDate.map(async (invoice) => ({ ...invoice, ...(await computeTotals(invoice.id)) }))
  );
}

export async function getInvoiceDetail(userId: string, invoiceId: string) {
  const invoice = await getOwnedInvoice(userId, invoiceId);
  const [installments, payments, totals] = await Promise.all([
    prisma.installment.findMany({
      where: { invoiceId },
      include: { purchase: true },
      orderBy: { dueDate: "asc" },
    }),
    prisma.invoicePayment.findMany({ where: { invoiceId }, orderBy: { paymentDate: "asc" } }),
    computeTotals(invoiceId),
  ]);
  return { ...invoice, ...totals, installments, payments };
}

export async function reassignInstallmentInvoice(userId: string, installmentId: string, newInvoiceId: string) {
  const installment = await prisma.installment.findUnique({ where: { id: installmentId }, include: { purchase: true } });
  if (!installment || installment.purchase.userId !== userId) throw AppError.notFound("Installment not found");

  const newInvoice = await getOwnedInvoice(userId, newInvoiceId);
  if (newInvoice.cardId !== installment.purchase.cardId) {
    throw AppError.badRequest("Target invoice must belong to the same card");
  }
  if (installment.status === "paid") {
    throw AppError.conflict("Cannot reassign a paid installment");
  }

  return prisma.installment.update({
    where: { id: installmentId },
    data: { invoiceId: newInvoiceId, status: newInvoice.status === "open" ? "pending" : "invoiced" },
  });
}
