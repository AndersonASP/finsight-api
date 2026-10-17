-- CreateTable
CREATE TABLE "wallet_card_mappings" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "wallet_name" TEXT NOT NULL,
    "card_id" TEXT,
    "account_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_card_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_card_mappings_user_id_wallet_name_key" ON "wallet_card_mappings"("user_id", "wallet_name");

-- AddForeignKey
ALTER TABLE "wallet_card_mappings" ADD CONSTRAINT "wallet_card_mappings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_card_mappings" ADD CONSTRAINT "wallet_card_mappings_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_card_mappings" ADD CONSTRAINT "wallet_card_mappings_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
