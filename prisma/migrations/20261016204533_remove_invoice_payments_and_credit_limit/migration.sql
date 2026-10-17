-- Remap existing data off the enum values being removed, before the enum
-- types themselves change shape (a cast to the narrower enum would otherwise
-- fail on any row still using "paid"/"partially_paid").
UPDATE "invoices" SET "status" = 'closed' WHERE "status" IN ('paid', 'partially_paid');
UPDATE "installments" SET "status" = 'invoiced' WHERE "status" = 'paid';

-- DropForeignKey
ALTER TABLE "invoice_payments" DROP CONSTRAINT IF EXISTS "invoice_payments_invoice_id_fkey";
ALTER TABLE "invoice_payments" DROP CONSTRAINT IF EXISTS "invoice_payments_account_id_fkey";

-- DropTable
DROP TABLE "invoice_payments";

-- AlterTable (cards)
ALTER TABLE "cards" DROP COLUMN "credit_limit";

-- AlterEnum (InstallmentStatus: drop "paid")
BEGIN;
CREATE TYPE "InstallmentStatus_new" AS ENUM ('pending', 'invoiced');
ALTER TABLE "installments" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "installments" ALTER COLUMN "status" TYPE "InstallmentStatus_new" USING ("status"::text::"InstallmentStatus_new");
ALTER TYPE "InstallmentStatus" RENAME TO "InstallmentStatus_old";
ALTER TYPE "InstallmentStatus_new" RENAME TO "InstallmentStatus";
DROP TYPE "InstallmentStatus_old";
ALTER TABLE "installments" ALTER COLUMN "status" SET DEFAULT 'pending';
COMMIT;

-- AlterEnum (InvoiceStatus: drop "paid", "partially_paid")
BEGIN;
CREATE TYPE "InvoiceStatus_new" AS ENUM ('open', 'closed');
ALTER TABLE "invoices" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "invoices" ALTER COLUMN "status" TYPE "InvoiceStatus_new" USING ("status"::text::"InvoiceStatus_new");
ALTER TYPE "InvoiceStatus" RENAME TO "InvoiceStatus_old";
ALTER TYPE "InvoiceStatus_new" RENAME TO "InvoiceStatus";
DROP TYPE "InvoiceStatus_old";
ALTER TABLE "invoices" ALTER COLUMN "status" SET DEFAULT 'open';
COMMIT;

-- CreateTable
CREATE TABLE "recurring_card_purchases" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "card_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "category_id" TEXT,
    "start_date" DATE NOT NULL,
    "occurrence_count" INTEGER NOT NULL,
    "is_open_ended" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recurring_card_purchases_pkey" PRIMARY KEY ("id")
);

-- AlterTable (purchases: link back to the recurring series)
ALTER TABLE "purchases" ADD COLUMN "recurring_card_purchase_id" TEXT,
ADD COLUMN "occurrence_index" INTEGER;

-- AddForeignKey
ALTER TABLE "recurring_card_purchases" ADD CONSTRAINT "recurring_card_purchases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recurring_card_purchases" ADD CONSTRAINT "recurring_card_purchases_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "recurring_card_purchases" ADD CONSTRAINT "recurring_card_purchases_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_recurring_card_purchase_id_fkey" FOREIGN KEY ("recurring_card_purchase_id") REFERENCES "recurring_card_purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
