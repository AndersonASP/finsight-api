-- CreateEnum
CREATE TYPE "DebtKind" AS ENUM ('parcela_fixa', 'saldo_variavel');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('imovel', 'veiculo', 'a_receber', 'outro');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DebtType" ADD VALUE 'financiamento';
ALTER TYPE "DebtType" ADD VALUE 'cheque_especial';

-- AlterTable
ALTER TABLE "debts" ADD COLUMN     "balance_updated_at" DATE,
ADD COLUMN     "first_installment_date" DATE,
ADD COLUMN     "kind" "DebtKind" NOT NULL DEFAULT 'saldo_variavel',
ADD COLUMN     "monthly_interest_rate" DECIMAL(6,3),
ADD COLUMN     "payoff_amount" DECIMAL(14,2),
ADD COLUMN     "payoff_amount_at" DATE;

-- CreateTable
CREATE TABLE "assets" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "valued_at" DATE NOT NULL,
    "is_liquid" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "net_worth_snapshots" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "assets" DECIMAL(14,2) NOT NULL,
    "liabilities" DECIMAL(14,2) NOT NULL,
    "net_worth" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "net_worth_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "net_worth_snapshots_user_id_year_month_key" ON "net_worth_snapshots"("user_id", "year", "month");

-- AddForeignKey
ALTER TABLE "assets" ADD CONSTRAINT "assets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "net_worth_snapshots" ADD CONSTRAINT "net_worth_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data: existing debts. A balance's "informed on" date is its last update.
UPDATE "debts" SET "balance_updated_at" = "updated_at"::date;

-- Debts with fixed installments become calendar-driven: as of updated_at,
-- `installments_paid` were paid and the next one is the first due date
-- after it, so installment #1 was that date minus installments_paid months.
UPDATE "debts" AS d
SET "kind" = 'parcela_fixa',
    "first_installment_date" = (
      (CASE WHEN dm.this_due > d."updated_at"::date THEN dm.this_due ELSE dm.next_due END)
      - make_interval(months => d."installments_paid")
    )::date
FROM (
  SELECT
    "id",
    date_trunc('month', "updated_at")::date
      + (LEAST(
          COALESCE("installment_due_day", EXTRACT(DAY FROM "updated_at")::int),
          EXTRACT(DAY FROM date_trunc('month', "updated_at") + interval '1 month - 1 day')::int
        ) - 1) AS this_due,
    date_trunc('month', "updated_at" + interval '1 month')::date
      + (LEAST(
          COALESCE("installment_due_day", EXTRACT(DAY FROM "updated_at")::int),
          EXTRACT(DAY FROM date_trunc('month', "updated_at" + interval '1 month') + interval '1 month - 1 day')::int
        ) - 1) AS next_due
  FROM "debts"
  WHERE "installments_total" IS NOT NULL AND "installment_amount" IS NOT NULL
) AS dm
WHERE d."id" = dm."id";
