-- CreateEnum
CREATE TYPE "RecurringTransactionStatus" AS ENUM ('active', 'cancelled');

-- CreateEnum
CREATE TYPE "RecurrenceInterval" AS ENUM ('daily', 'weekly', 'biweekly', 'monthly', 'annual');

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "occurrence_index" INTEGER,
ADD COLUMN     "recurring_transaction_id" TEXT;

-- CreateTable
CREATE TABLE "recurring_transactions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "counterpart_account_id" TEXT,
    "type" "TransactionType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "category_id" TEXT,
    "description" TEXT,
    "start_date" DATE NOT NULL,
    "interval" "RecurrenceInterval" NOT NULL DEFAULT 'monthly',
    "occurrence_count" INTEGER NOT NULL,
    "is_open_ended" BOOLEAN NOT NULL DEFAULT false,
    "status" "RecurringTransactionStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recurring_transactions_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_recurring_transaction_id_fkey" FOREIGN KEY ("recurring_transaction_id") REFERENCES "recurring_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_transactions_counterpart_account_id_fkey" FOREIGN KEY ("counterpart_account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_transactions" ADD CONSTRAINT "recurring_transactions_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
