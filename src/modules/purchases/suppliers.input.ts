import { HttpError } from "../../shared/http/http-error";
import { object, requiredText } from "./purchases.input";

export function optionalText(value: unknown, name: string, max: number): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > max) throw new HttpError(400, `Invalid ${name}.`);
  return value.trim() || null;
}
export function booleanInput(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new HttpError(400, `Invalid ${name}.`);
  return value;
}
export function activeFilter(value: unknown): boolean | undefined {
  if (value === undefined || value === "all") return undefined;
  if (value !== "true" && value !== "false") throw new HttpError(400, "Invalid isActive filter.");
  return value === "true";
}
export function supplierInput(value: unknown, patch = false) {
  const body = object(value);
  const allowed = ["name", "phone", "contactPerson", "supplierCode", "email", "address", "taxCode", "note", "isActive"];
  if (Object.keys(body).some(key => !allowed.includes(key)) || (patch && !Object.keys(body).length)) throw new HttpError(400, "Invalid supplier fields. Debt must be updated through documents.");
  const data: { name?: string; phone?: string | null; contactPerson?: string | null; supplierCode?: string | null; email?: string | null; address?: string | null; taxCode?: string | null; note?: string | null; isActive?: boolean } = {};
  if (!patch || body.name !== undefined) data.name = requiredText(body.name, "name", 255);
  for (const [key, max] of [["phone", 20], ["contactPerson", 100], ["supplierCode", 50], ["email", 255], ["address", 5000], ["taxCode", 30], ["note", 5000]] as const) {
    if (body[key] !== undefined) data[key] = optionalText(body[key], key, max);
  }
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) throw new HttpError(400, "Email NCC không hợp lệ.");
  if (body.isActive !== undefined) data.isActive = booleanInput(body.isActive, "isActive");
  return data;
}
