import { prisma } from "../../core/db/prisma.js";

/**
 * Wipes every row this user owns across the whole app — same dependency
 * order as test/integration/helpers.ts's cleanupDatabase, just scoped to one
 * userId and keeping the User row itself (this is "reiniciar o projeto", not
 * "delete my account"). Then recreates the two accounts every "adicionar"
 * flow assumes exist: a checking account for everyday money and a
 * savings_reserve one for the emergency fund, both renameable afterward.
 */
export async function resetUserData(userId: string) {
  await prisma.$transaction([
    prisma.scenarioBudgetItem.deleteMany({ where: { scenario: { userId } } }),
    prisma.scenarioInstallment.deleteMany({ where: { scenarioPurchase: { scenario: { userId } } } }),
    prisma.scenarioPurchase.deleteMany({ where: { scenario: { userId } } }),
    prisma.scenarioTransaction.deleteMany({ where: { scenario: { userId } } }),
    prisma.scenario.deleteMany({ where: { userId } }),
    prisma.reserveLoanRepayment.deleteMany({ where: { loan: { userId } } }),
    prisma.reserveLoan.deleteMany({ where: { userId } }),
    prisma.recurringTransaction.deleteMany({ where: { userId } }),
    prisma.debtPayment.deleteMany({ where: { debt: { userId } } }),
    prisma.debt.deleteMany({ where: { userId } }),
    prisma.asset.deleteMany({ where: { userId } }),
    prisma.netWorthSnapshot.deleteMany({ where: { userId } }),
    prisma.walletCardMapping.deleteMany({ where: { userId } }),
    prisma.installment.deleteMany({ where: { purchase: { userId } } }),
    prisma.recurringCardPurchase.deleteMany({ where: { userId } }),
    prisma.invoice.deleteMany({ where: { userId } }),
    prisma.purchase.deleteMany({ where: { userId } }),
    prisma.card.deleteMany({ where: { userId } }),
    prisma.budgetItem.deleteMany({ where: { userId } }),
    prisma.transaction.deleteMany({ where: { userId } }),
    prisma.accountBalanceSnapshot.deleteMany({ where: { account: { userId } } }),
    prisma.account.deleteMany({ where: { userId } }),
    prisma.category.deleteMany({ where: { userId } }),
    prisma.savingsGoal.deleteMany({ where: { userId } }),
  ]);

  const checking = await prisma.account.create({
    data: { userId, name: "Conta corrente", type: "checking", initialBalance: "0" },
  });
  const reserve = await prisma.account.create({
    data: { userId, name: "Reserva de emergência", type: "savings_reserve", initialBalance: "0" },
  });

  return { accounts: [checking, reserve] };
}
