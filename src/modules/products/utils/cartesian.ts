// src/modules/products/utils/cartesian.ts
export function cartesian<T>(arrays: T[][]): T[][] {
  if (arrays.length === 0) return [];
  return arrays.reduce<T[][]>(
    (acc, curr) => acc.flatMap((x) => curr.map((y) => [...x, y])),
    [[]]
  );
}