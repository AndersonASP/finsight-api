-- Every existing bem starts its value history with its current value.
INSERT INTO "asset_valuations" ("id", "asset_id", "valued_at", "value")
SELECT gen_random_uuid()::text, "id", "valued_at", "value" FROM "assets"
ON CONFLICT ("asset_id", "valued_at") DO NOTHING;
