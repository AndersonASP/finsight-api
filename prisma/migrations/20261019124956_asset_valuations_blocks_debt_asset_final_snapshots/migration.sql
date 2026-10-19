-- CreateEnum
CREATE TYPE "AssetBlock" AS ENUM ('outros', 'investimentos');

-- AlterTable
ALTER TABLE "assets" ADD COLUMN     "block" "AssetBlock" NOT NULL DEFAULT 'outros';

-- AlterTable
ALTER TABLE "debts" ADD COLUMN     "asset_id" TEXT;

-- AlterTable
ALTER TABLE "net_worth_snapshots" ADD COLUMN     "is_final" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "asset_valuations" (
    "id" TEXT NOT NULL,
    "asset_id" TEXT NOT NULL,
    "valued_at" DATE NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_valuations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "asset_valuations_asset_id_valued_at_key" ON "asset_valuations"("asset_id", "valued_at");

-- AddForeignKey
ALTER TABLE "debts" ADD CONSTRAINT "debts_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_valuations" ADD CONSTRAINT "asset_valuations_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
