import { Prisma } from "@prisma/client";
import { prisma } from "../../core/db/prisma.js";
import { AppError } from "../../core/http/errors.js";

export interface InvoicePaymentInput {
  accountId: string;
  paymentDate: Date;
  amount: string;
  interestAmount?: string;
}

async function getOwnedInvoice(userId: string, invoiceId: string) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice || invoice.userId !== userId) throw AppError.notFound("Invoice not found");
  return invoice;
}

/**
 * Recomputes the invoice's status from its actual payments total, rather than
 * trusting the caller — `paid` once fully covered, `partially_paid` once
 * something has been paid but not all of it. Never regresses `open`/`closed`
 * to something earlier; only ever moves forward as payments accrue.
 */
export async function syncInvoiceStatus(tx: Prisma.TransactionClient, invoiceId: string) {
  const [installmentsTotal, paymentsTotal] = await Promise.all([
    tx.installment.aggregate({ _sum: { amount: true }, where: { invoiceId } }),
    tx.invoicePayment.aggregate({ _sum: { amount: true }, where: { invoiceId } }),
  ]);
  const total = new Prisma.Decimal(installmentsTotal._sum.amount ?? 0);
  const paid = new Prisma.Decimal(paymentsTotal._sum.amount ?? 0);

  const status = paid.greaterThanOrEqualTo(total) && total.greaterThan(0) ? "paid" : paid.greaterThan(0) ? "partially_paid" : undefined;

  if (status) {
    await tx.invoice.update({ where: { id: invoiceId }, data: { status } });
  }
}

export async function listPayments(userId: string, invoiceId: string) {
  await getOwnedInvoice(userId, invoiceId);
  return prisma.invoicePayment.findMany({ where: { invoiceId }, orderBy: { paymentDate: "asc" } });
}

/**
 * Creates the payment and (re)syncs invoice status. This is deliberately a new
 * row in `invoice_payments`, never a `transactions` entry — the purchases
 * that make up the invoice are already the original expenses (RF-12), so
 * paying the bill must never be double-counted as a new one. Takes a
 * transaction client so `confirmScenario` (RF-13) can reuse it verbatim.
 */
export async function createPaymentInTx(
  tx: Prisma.TransactionClient,
  userId: string,
  invoiceId: string,
  input: InvoicePaymentInput
) {
  const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice || invoice.userId !== userId) throw AppError.notFound("Invoice not found");

  const account = await tx.account.findUnique({ where: { id: input.accountId } });
  if (!account || account.userId !== userId) throw AppError.notFound("Account not found");

  if (new Prisma.Decimal(input.amount).lessThanOrEqualTo(0)) {
    throw AppError.badRequest("amount must be greater than zero");
  }

  const payment = await tx.invoicePayment.create({
    data: {
      invoiceId,
      accountId: input.accountId,
      paymentDate: input.paymentDate,
      amount: input.amount,
      interestAmount: input.interestAmount ?? "0",
    },
  });
  await syncInvoiceStatus(tx, invoiceId);
  return payment;
}

export async function createPayment(userId: string, invoiceId: string, input: InvoicePaymentInput) {
  return prisma.$transaction((tx) => createPaymentInTx(tx, userId, invoiceId, input));
}
