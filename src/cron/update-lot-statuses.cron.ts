import { prisma } from "../shared/infrastructure/database/prisma.client";

export type LotStatusTransition = { from: string; to: string; count: number };

export type UpdateLotStatusesResult =
  | { success: true; transitions: LotStatusTransition[]; updatedCount: number; timestamp: Date }
  | { success: false; error: string; timestamp: Date };

/**
 * Daily job (06:00 Asia/Ho_Chi_Minh, see server.ts) that stores the calculated lot status.
 *
 * One idempotent UPDATE moves every lot item that is not QUARANTINED or SCRAPPED to HEALTHY, WARNING or
 * UNUSABLE using the same thresholds as LotStatusService.calculateStatus:
 *   more than 60 days left -> HEALTHY, 8 to 60 -> WARNING, 7 or fewer (including expired) -> UNUSABLE.
 * Days are counted from today's date in Vietnam, since the job is scheduled in that timezone.
 * Only rows whose status actually changes are written.
 */
export async function updateLotStatusesCron(): Promise<UpdateLotStatusesResult> {
  try {
    const rows = await prisma.$queryRaw<Array<{ from_status: string; to_status: string; count: number }>>`
      WITH target AS (
        SELECT
          id,
          status AS old_status,
          CASE
            WHEN (expiration_date - (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) > 60 THEN 'HEALTHY'
            WHEN (expiration_date - (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) >= 8 THEN 'WARNING'
            ELSE 'UNUSABLE'
          END AS new_status
        FROM product_lot_items
        WHERE status NOT IN ('QUARANTINED', 'SCRAPPED')
      ),
      changed AS (
        UPDATE product_lot_items AS p
        SET status = t.new_status
        FROM target AS t
        WHERE p.id = t.id AND p.status <> t.new_status
        RETURNING t.old_status AS old_status, t.new_status AS new_status
      )
      SELECT old_status AS from_status, new_status AS to_status, COUNT(*)::int AS count
      FROM changed
      GROUP BY old_status, new_status
      ORDER BY old_status, new_status
    `;

    const transitions = rows.map((row) => ({ from: row.from_status, to: row.to_status, count: Number(row.count) }));
    const updatedCount = transitions.reduce((sum, row) => sum + row.count, 0);

    console.log(
      `Lot status job finished: ${updatedCount} lot(s) changed`,
      transitions.length ? transitions : "",
    );

    return { success: true, transitions, updatedCount, timestamp: new Date() };
  } catch (error) {
    console.error("Lot status job failed.", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
      timestamp: new Date(),
    };
  }
}
