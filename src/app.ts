import cors from "cors";
import express from "express";
import helmet from "helmet";
import "./core/money/decimal-json.js";
import { env } from "./core/config/env.js";
import { authGuard } from "./core/http/auth-guard.js";
import { errorHandler } from "./core/http/error-handler.js";
import { accountsRouter } from "./modules/accounts/accounts.routes.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { billsRouter } from "./modules/bills/bills.routes.js";
import { budgetRouter } from "./modules/budget/budget.routes.js";
import { cardsRouter } from "./modules/cards/cards.routes.js";
import { categoriesRouter } from "./modules/categories/categories.routes.js";
import { installmentsRouter, invoicesRouter } from "./modules/invoices/invoices.routes.js";
import { debtsRouter } from "./modules/debts/debts.routes.js";
import { purchasesRouter } from "./modules/purchases/purchases.routes.js";
import { recurringCardPurchasesRouter } from "./modules/recurring-card-purchases/recurring-card-purchases.routes.js";
import { recurringTransactionsRouter } from "./modules/recurring-transactions/recurring-transactions.routes.js";
import { reportsRouter } from "./modules/reports/reports.routes.js";
import { resetRouter } from "./modules/reset/reset.routes.js";
import { reserveLoansRouter } from "./modules/reserve-loans/reserve-loans.routes.js";
import { savingsGoalsRouter } from "./modules/savings-goals/savings-goals.routes.js";
import { scenariosRouter } from "./modules/scenarios/scenarios.routes.js";
import { transactionsRouter } from "./modules/transactions/transactions.routes.js";

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

app.use("/accounts", authGuard, accountsRouter);
app.use("/transactions", authGuard, transactionsRouter);
app.use("/categories", authGuard, categoriesRouter);
app.use("/budget-items", authGuard, budgetRouter);
app.use("/reports", authGuard, reportsRouter);
app.use("/cards", authGuard, cardsRouter);
app.use("/purchases", authGuard, purchasesRouter);
app.use("/invoices", authGuard, invoicesRouter);
app.use("/installments", authGuard, installmentsRouter);
app.use("/scenarios", authGuard, scenariosRouter);
app.use("/savings-goals", authGuard, savingsGoalsRouter);
app.use("/reserve-loans", authGuard, reserveLoansRouter);
app.use("/recurring-transactions", authGuard, recurringTransactionsRouter);
app.use("/recurring-card-purchases", authGuard, recurringCardPurchasesRouter);
app.use("/debts", authGuard, debtsRouter);
app.use("/bills", authGuard, billsRouter);
app.use("/reset", authGuard, resetRouter);

app.use(errorHandler);
