import cors from "cors";
import express from "express";
import helmet from "helmet";
import "./core/money/decimal-json.js";
import { env } from "./core/config/env.js";
import { asyncHandler } from "./core/http/async-handler.js";
import { authGuard, requireUserId } from "./core/http/auth-guard.js";
import { getDataVersion, trackDataChanges } from "./core/http/data-version.js";
import { errorHandler } from "./core/http/error-handler.js";
import { accountsRouter } from "./modules/accounts/accounts.routes.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { billsRouter } from "./modules/bills/bills.routes.js";
import { budgetRouter } from "./modules/budget/budget.routes.js";
import { cardsRouter } from "./modules/cards/cards.routes.js";
import { categoriesRouter } from "./modules/categories/categories.routes.js";
import { installmentsRouter, invoicesRouter } from "./modules/invoices/invoices.routes.js";
import { debtsRouter } from "./modules/debts/debts.routes.js";
import { insightsRouter } from "./modules/insights/insights.routes.js";
import { purchasesRouter } from "./modules/purchases/purchases.routes.js";
import { quickEntriesRouter } from "./modules/quick-entries/quick-entries.routes.js";
import { recurringCardPurchasesRouter } from "./modules/recurring-card-purchases/recurring-card-purchases.routes.js";
import { recurringTransactionsRouter } from "./modules/recurring-transactions/recurring-transactions.routes.js";
import { reportsRouter } from "./modules/reports/reports.routes.js";
import { resetRouter } from "./modules/reset/reset.routes.js";
import { reserveLoansRouter } from "./modules/reserve-loans/reserve-loans.routes.js";
import { savingsGoalsRouter } from "./modules/savings-goals/savings-goals.routes.js";
import { scenariosRouter } from "./modules/scenarios/scenarios.routes.js";
import { settingsRouter } from "./modules/settings/settings.routes.js";
import { transactionsRouter } from "./modules/transactions/transactions.routes.js";
import { assetsRouter, wealthRouter } from "./modules/wealth/wealth.routes.js";
import { wishlistRouter } from "./modules/wishlist/wishlist.routes.js";

export const app = express();

// Behind Render's load balancer every request arrives from the proxy's IP;
// trusting one hop makes rate limiting key on the real client IP.
if (env.NODE_ENV === "production") app.set("trust proxy", 1);

app.use(helmet());

app.use(cors({ origin: env.CORS_ORIGIN }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/auth", authRouter);

// Every authenticated route: writes bump the user's data version.
const authed = [authGuard, trackDataChanges];

app.get(
  "/sync/version",
  authGuard,
  asyncHandler(async (req, res) => {
    res.json(await getDataVersion(requireUserId(req)));
  })
);

app.use("/accounts", ...authed, accountsRouter);
app.use("/transactions", ...authed, transactionsRouter);
app.use("/categories", ...authed, categoriesRouter);
app.use("/budget-items", ...authed, budgetRouter);
app.use("/reports", ...authed, reportsRouter);
app.use("/cards", ...authed, cardsRouter);
app.use("/purchases", ...authed, purchasesRouter);
app.use("/invoices", ...authed, invoicesRouter);
app.use("/installments", ...authed, installmentsRouter);
app.use("/scenarios", ...authed, scenariosRouter);
app.use("/savings-goals", ...authed, savingsGoalsRouter);
app.use("/reserve-loans", ...authed, reserveLoansRouter);
app.use("/recurring-transactions", ...authed, recurringTransactionsRouter);
app.use("/recurring-card-purchases", ...authed, recurringCardPurchasesRouter);
app.use("/debts", ...authed, debtsRouter);
app.use("/settings", ...authed, settingsRouter);
app.use("/bills", ...authed, billsRouter);
app.use("/quick-entries", ...authed, quickEntriesRouter);
app.use("/wealth", ...authed, wealthRouter);
app.use("/assets", ...authed, assetsRouter);
app.use("/insights", ...authed, insightsRouter);
app.use("/wishlist", ...authed, wishlistRouter);
app.use("/reset", ...authed, resetRouter);

app.use(errorHandler);
