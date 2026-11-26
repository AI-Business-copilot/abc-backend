import { Prisma } from "@prisma/client";

import { HttpError } from "../../shared/http/http-error";
import { getProductPerformance, performanceRanges } from "./product-performance.service";

type Performance = Awaited<ReturnType<typeof getProductPerformance>>;

export function buildBusinessMovement(snapshot: Performance) {
  const { current, previous } = snapshot.totals;
  const component = (key: "grossSales" | "discountAmount" | "refundAmount" | "netRevenue" | "netCogs", sign: 1 | -1) => {
    const difference = new Prisma.Decimal(current[key]).minus(previous[key]);
    return {
      current: current[key],
      previous: previous[key],
      difference: difference.toFixed(2),
      impact: difference.mul(sign).toFixed(2),
    };
  };
  return {
    ...snapshot,
    components: {
      grossSales: component("grossSales", 1),
      discountAmount: component("discountAmount", -1),
      refundAmount: component("refundAmount", -1),
      netRevenue: component("netRevenue", 1),
      netCogs: component("netCogs", -1),
    },
  };
}

export async function getBusinessMovement(businessId: string, query: Record<string, unknown>) {
  const ranges = performanceRanges(query.from, query.to);
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  if (ranges.current.to > today) throw new HttpError(400, "The period cannot end in the future.");
  const snapshot = await getProductPerformance(businessId, {
    from: ranges.current.from, to: ranges.current.to, all: "true",
  });
  return buildBusinessMovement(snapshot);
}
