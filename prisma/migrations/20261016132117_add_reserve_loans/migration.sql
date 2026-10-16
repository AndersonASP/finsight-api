-- CreateEnum
CREATE TYPE "ReserveLoanStatus" AS ENUM ('active', 'settled');

-- CreateTable
CREATE TABLE "reserve_loans" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "reserve_account_id" TEXT NOT NULL,
    "destination_account_id" TEXT NOT NULL,
    "principal" DECIMAL(14,2) NOT NULL,
    "borrow_date" DATE NOT NULL,
    "monthly_interest_rate" DECIMAL(5,2) NOT NULL DEFAULT 10,
    "status" "ReserveLoanStatus" NOT NULL DEFAULT 'active',
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reserve_loans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reserve_loan_repayments" (
    "id" TEXT NOT NULL,
    "loan_id" TEXT NOT NULL,
    "repayment_date" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "interest_portion" DECIMAL(14,2) NOT NULL,
    "principal_portion" DECIMAL(14,2) NOT NULL,
    "outstanding_principal_after" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reserve_loan_repayments_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "reserve_loans" ADD CONSTRAINT "reserve_loans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reserve_loans" ADD CONSTRAINT "reserve_loans_reserve_account_id_fkey" FOREIGN KEY ("reserve_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reserve_loans" ADD CONSTRAINT "reserve_loans_destination_account_id_fkey" FOREIGN KEY ("destination_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reserve_loan_repayments" ADD CONSTRAINT "reserve_loan_repayments_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "reserve_loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
