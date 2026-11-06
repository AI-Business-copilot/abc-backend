import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

function buildConnectionString(raw?: string) {
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    url.searchParams.delete("sslmode");
    return url.toString();
  } catch {
    return raw;
  }
}

const adapter = new PrismaPg({
  connectionString: buildConnectionString(process.env.DATABASE_URL)!,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

const prisma = new PrismaClient({ adapter });

async function main() {
  const ownerUser = await prisma.user.findFirst({
    where: { email: "huongtuti511@gmail.com" },
  });
  if (ownerUser) {
    const ownerRole = await prisma.role.findFirst({ where: { code: "OWNER" } });
    if (ownerRole) {
      await prisma.businessMembership.upsert({
        where: {
          businessId_userId: {
            businessId: "34344b30-5ac6-4375-9d84-52c993d25ed7",
            userId: ownerUser.id,
          },
        },
        update: { status: "ACTIVE", roleId: ownerRole.id },
        create: {
          businessId: "34344b30-5ac6-4375-9d84-52c993d25ed7",
          userId: ownerUser.id,
          roleId: ownerRole.id,
          status: "ACTIVE",
        },
      });
      console.log("Successfully ensured huongtuti511 is ACTIVE OWNER of Shop thoi trang H&X!");
    }
  }
  await prisma.$disconnect();
}

main().catch(console.error);
