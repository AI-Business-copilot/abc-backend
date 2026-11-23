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

const BUSINESS_ID = "2f3788b8-e48e-4dbd-8e55-98c82c618be6";
const OWNER_USER_ID = "3c1e6e4e-7ac8-47d6-a502-183705abb237";

async function main() {
  const staffRole = await prisma.role.findFirst({ where: { code: "STAFF" } });
  if (!staffRole) throw new Error("STAFF role missing");
  const ownerRole = await prisma.role.findFirst({ where: { code: "OWNER" } });
  if (!ownerRole) throw new Error("OWNER role missing");

  // A second user that acts as the staff member of this business.
  const staffUser = await prisma.user.findFirst({
    where: { email: "staff.f07.f08@gmail.com" },
  });
  let staffUserId = staffUser?.id;
  if (!staffUserId) {
    const created = await prisma.user.create({
      data: {
        email: "staff.f07.f08@gmail.com",
        fullName: "Nhân viên Kiểm Kê",
        authUserId: "6cca5778-e2c6-44c8-84f7-ebe9a1c712db",
      },
    });
    staffUserId = created.id;
  }

  await prisma.businessMembership.upsert({
    where: {
      businessId_userId: { businessId: BUSINESS_ID, userId: staffUserId },
    },
    update: { status: "ACTIVE", roleId: staffRole.id },
    create: {
      businessId: BUSINESS_ID,
      userId: staffUserId,
      roleId: staffRole.id,
      status: "ACTIVE",
    },
  });

  console.log(JSON.stringify({ staffUserId, ownerUserId: OWNER_USER_ID }, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
