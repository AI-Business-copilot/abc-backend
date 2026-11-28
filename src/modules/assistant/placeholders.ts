import { HttpError } from "../../shared/http/http-error";

const TOKEN = /X\d{3,}/g;
const MAX_VALUES = 999;

/**
 * Keeps values in the backend; callers must separately ensure that any text sent
 * alongside these tokens contains no sensitive information.
 */
export function createPlaceholders(values: readonly string[]) {
  if (values.length > MAX_VALUES || values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new HttpError(500, "Không thể tạo dữ liệu thay thế cho trợ lý.");
  }
  const tokens = values.map((_, index) => `X${String(index + 1).padStart(3, "0")}`);
  const lookup = new Map(tokens.map((token, index) => [token, values[index]]));

  function restore(text: string) {
    if (typeof text !== "string") throw new HttpError(502, "Trợ lý trả nội dung không hợp lệ.");
    const matches = text.match(TOKEN) ?? [];
    if (matches.some((token) => !lookup.has(token)) || new Set(matches).size !== matches.length) {
      throw new HttpError(502, "Trợ lý trả mã thay thế không hợp lệ.");
    }
    if (/\p{N}/u.test(text.replace(TOKEN, ""))) {
      throw new HttpError(502, "Trợ lý trả số liệu không có căn cứ.");
    }
    return text.replace(TOKEN, (token) => lookup.get(token)!);
  }

  return { tokens, restore };
}
