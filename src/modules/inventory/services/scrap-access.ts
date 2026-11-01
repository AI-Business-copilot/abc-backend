import type { Prisma } from "@prisma/client";

import { HttpError } from "../../../shared/http/http-error";

/** The signed-in user as the services see them: users.id plus the business role code (OWNER or STAFF). */
export type ScrapActor = { userId: string; role: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertStaff(actor: ScrapActor): void {
  if (!actor.userId || actor.role !== "STAFF") {
    throw new HttpError(403, "Only staff members can do this.");
  }
}

export function assertOwner(actor: ScrapActor): void {
  if (!actor.userId || actor.role !== "OWNER") {
    throw new HttpError(403, "Only the business owner can do this.");
  }
}

/** Rejects malformed ids early so they become a 4xx instead of a database cast error. */
export function assertUuid(value: unknown, label: string, status = 404): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new HttpError(status, `${label} not found`);
  }
  return value;
}

export type LockedScrapOrder = { id: string; status: string; created_by: string };

/**
 * Locks the scrap order row until the transaction ends. Uploads, deletes, approve and reject all
 * take this lock first, so an approval can never run while photos are being added or removed.
 */
export async function lockScrapOrder(
  tx: Prisma.TransactionClient,
  businessId: string,
  scrapOrderId: string,
): Promise<LockedScrapOrder> {
  const rows = await tx.$queryRaw<LockedScrapOrder[]>`
    SELECT id, status, created_by
    FROM scrap_orders
    WHERE id = ${scrapOrderId}::uuid AND business_id = ${businessId}::uuid
    FOR UPDATE
  `;
  if (!rows[0]) {
    throw new HttpError(404, "Scrap order not found");
  }
  return rows[0];
}
