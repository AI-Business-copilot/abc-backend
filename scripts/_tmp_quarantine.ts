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
  const BUSINESS_ID = "2f3788b8-e48e-4dbd-8e55-98c82c618be6";
  const ITEM_ID = "22222222-2222-4222-8222-222222222222";
  const USER_ID = "004b203f-7d4f-45e8-b159-634be378d243";

  const user = await prisma.user.findUnique({ where: { id: USER_ID }, select: { id: true, email: true } });
  console.log("user:", user);

  try {
    const r = await prisma.$transaction(async (tx) => {
      const item = await tx.productLotItem.findUnique({ where: { id: ITEM_ID } });
      console.log("item found:", !!item);
      return await tx.productLotItem.update({
        where: { id: ITEM_ID },
        data: {
          status: "QUARANTINED",
          quarantineQty: 3,
          quarantinedAt: new Date(),
          quarantinedBy: USER_ID,
          quarantineNote: "Het han",
        },
      });
    });
    console.log("OK", r);
  } catch (e) {
    console.error("FAILED", e);
  }
  await prisma.$disconnect();
}

main();
