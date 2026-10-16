import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const email = process.env.SEED_EMAIL;
  const password = process.env.SEED_PASSWORD;

  if (!email || !password) {
    throw new Error("SEED_EMAIL and SEED_PASSWORD must be set (see .env.example)");
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash },
    create: { email, passwordHash },
  });

  // Without this, a freshly seeded user has no account and every "adicionar"
  // flow in the app dead-ends on "cadastre uma conta primeiro" — give them a
  // zero-balance checking account to start from, renameable later.
  const hasAccount = await prisma.account.findFirst({ where: { userId: user.id } });
  if (!hasAccount) {
    await prisma.account.create({
      data: { userId: user.id, name: "Conta corrente", type: "checking", initialBalance: "0" },
    });
    console.log("Created default checking account");
  }

  console.log(`Seeded user ${user.email} (${user.id})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
