import { config } from "dotenv";

// Loaded before any test file's imports, so `env.ts`'s own `dotenv/config`
// (which defaults to `.env`) finds these already set and does not override them.
config({ path: ".env.test" });
