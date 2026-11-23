import { HttpError } from "../../shared/http/http-error";

export function normalizeTaxCode(value: unknown): string {
  const code = typeof value === "string" ? value.trim().replace(/\s/g, "") : "";
  if (!/^(\d{10}|\d{12}|\d{10}-\d{3}|\d{13})$/.test(code)) throw new HttpError(400, "Mã số thuế phải gồm 10 số, 12 số hoặc 10-3 số cho chi nhánh.");
  return /^\d{13}$/.test(code) ? `${code.slice(0, 10)}-${code.slice(10)}` : code;
}

let token: { value: string; until: number } | undefined;
let pendingToken: Promise<string> | undefined;
async function request(url: string, init: RequestInit = {}) {
  try { return await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }); }
  catch { throw new HttpError(503, "Dịch vụ tra cứu đang bận. Bạn có thể nhập thông tin thủ công hoặc thử lại."); }
}
async function accessToken() {
  if (token && token.until > Date.now()) return token.value;
  if (pendingToken) return pendingToken;
  const app_id = process.env.CASSO_APP_ID;
  const app_secret = process.env.CASSO_APP_SECRET;
  if (!app_id || !app_secret) throw new HttpError(503, "Chưa cấu hình dịch vụ tra cứu mã số thuế. Vui lòng nhập thông tin thủ công.");
  pendingToken = (async () => {
    const response = await request("https://openapi.casso.vn/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app_id, app_secret }),
    });
    if (!response.ok) throw new HttpError(503, "Không thể kết nối dịch vụ tra cứu. Vui lòng kiểm tra cấu hình hoặc hạn mức.");
    const data = await response.json();
    if (typeof data.access_token !== "string") throw new HttpError(502, "Dịch vụ tra cứu trả về dữ liệu không hợp lệ.");
    const seconds = Number(data.expires_in);
    token = { value: data.access_token, until: Date.now() + (Number.isFinite(seconds) && seconds > 60 ? Math.min(seconds - 60, 840) : 60) * 1000 };
    return token.value;
  })();
  try { return await pendingToken; } finally { pendingToken = undefined; }
}

export async function lookupSupplierTax(value: unknown) {
  const taxCode = normalizeTaxCode(value);
  for (let attempt = 0; attempt < 2; attempt++) {
    const bearer = await accessToken();
    const kind = /^\d{12}$/.test(taxCode) ? "household" : "business";
    const response = await request(`https://openapi.casso.vn/idkit/v1/${kind}/${taxCode}`, { headers: { Authorization: `Bearer ${bearer}` } });
    if (response.status === 401 && attempt === 0) { token = undefined; continue; }
    if (response.status === 404) throw new HttpError(404, "Không tìm thấy thông tin cho mã số thuế này.");
    if (response.status === 429) throw new HttpError(429, "Đã hết hạn mức tra cứu. Vui lòng thử lại sau.");
    if (!response.ok) throw new HttpError(503, "Dịch vụ tra cứu chưa sẵn sàng. Bạn có thể nhập thủ công.");
    const result = await response.json();
    const business = result.business ?? result.household ?? result.data?.business ?? result.data?.household;
    if (!business || typeof business.name !== "string" || !business.name.trim() || business.name.length > 255 || typeof business.address !== "string" || business.address.length > 5000) {
      throw new HttpError(502, "Dịch vụ tra cứu trả về thông tin chưa đầy đủ.");
    }
    if (business.taxCode && normalizeTaxCode(business.taxCode) !== taxCode) throw new HttpError(502, "Mã số thuế trả về không khớp.");
    return { taxCode, name: business.name.trim(), address: business.address.trim(), source: "Casso IDKit" };
  }
  throw new HttpError(503, "Không thể xác thực dịch vụ tra cứu.");
}
