-- DropForeignKey
ALTER TABLE "scenario_invoice_payments" DROP CONSTRAINT IF EXISTS "scenario_invoice_payments_account_id_fkey";
ALTER TABLE "scenario_invoice_payments" DROP CONSTRAINT IF EXISTS "scenario_invoice_payments_card_id_fkey";
ALTER TABLE "scenario_invoice_payments" DROP CONSTRAINT IF EXISTS "scenario_invoice_payments_real_invoice_id_fkey";
ALTER TABLE "scenario_invoice_payments" DROP CONSTRAINT IF EXISTS "scenario_invoice_payments_scenario_id_fkey";

-- DropTable
DROP TABLE "scenario_invoice_payments";
