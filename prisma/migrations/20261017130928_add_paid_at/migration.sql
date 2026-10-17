-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "paid_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "paid_at" TIMESTAMP(3);
