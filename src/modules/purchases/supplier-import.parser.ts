import ExcelJS from "exceljs";
import { Readable } from "node:stream";
import { HttpError } from "../../shared/http/http-error";
import { money, requiredText } from "./purchases.input";

export const importFields = ["sku", "name", "price", "supplierSku", "unit"] as const;
export type ImportField = typeof importFields[number];
export type ImportMapping = Partial<Record<ImportField, number>>;
export type ImportLine = { row: number; sku: string; name: string; price: string; supplierSku: string; unit: string; error?: string };
const aliases: Record<ImportField, string[]> = {
  sku: ["sku", "sku noi bo", "ma san pham", "ma hang"], name: ["name", "ten san pham", "ten hang", "san pham"],
  price: ["price", "supplyprice", "gia", "gia chao", "gia nhap", "don gia"],
  supplierSku: ["suppliersku", "ma hang ncc", "ma ncc"], unit: ["unit", "don vi", "dvt", "don vi tinh"],
};
const normalize = (value: string) => value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").trim();
function cell(row: ExcelJS.Row, column: number | undefined) {
  if (!column) return "";
  const value = row.getCell(column).value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if ("richText" in value) return value.richText.map(part => part.text).join("").trim();
    throw new Error("Ô công thức, ngày hoặc liên kết không được hỗ trợ; hãy dán giá trị thuần.");
  }
  return String(value).trim();
}
export async function parseSupplierFile(file: { originalname: string; buffer: Buffer }, supplied?: unknown) {
  const workbook = new ExcelJS.Workbook();
  try {
    if (/\.csv$/i.test(file.originalname)) await workbook.csv.read(Readable.from([file.buffer]), { parserOptions: { delimiter: file.buffer.toString("utf8").split(/\r?\n/)[0]?.includes(";") ? ";" : "," }, map: value => value });
    else if (/\.xlsx$/i.test(file.originalname)) await workbook.xlsx.load(file.buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    else throw new Error();
  } catch { throw new HttpError(400, "Không đọc được file. Hãy dùng Excel .xlsx hoặc CSV UTF-8."); }
  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount < 2) throw new HttpError(400, "File phải có tiêu đề ở dòng đầu và ít nhất một sản phẩm.");
  if (sheet.rowCount > 501 || sheet.columnCount > 100) throw new HttpError(400, "Mỗi file tối đa 500 sản phẩm và 100 cột.");
  let headers: string[];
  try { headers = Array.from({ length: sheet.columnCount }, (_, i) => cell(sheet.getRow(1), i + 1) || `Cột ${i + 1}`); }
  catch { throw new HttpError(400, "Tiêu đề cột phải là văn bản thuần."); }
  const mapping: ImportMapping = {};
  if (supplied !== undefined) {
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied) || Object.keys(supplied).some(key => !importFields.includes(key as ImportField))) throw new HttpError(400, "Ánh xạ cột không hợp lệ.");
    for (const field of importFields) {
      const index = (supplied as ImportMapping)[field];
      if (index !== undefined && (!Number.isInteger(index) || index < 1 || index > headers.length)) throw new HttpError(400, "Cột được chọn không hợp lệ.");
      if (index !== undefined) mapping[field] = index;
    }
  } else for (const field of importFields) {
    const index = headers.findIndex(header => aliases[field].includes(normalize(header)));
    if (index >= 0) mapping[field] = index + 1;
  }
  if (new Set(Object.values(mapping)).size !== Object.values(mapping).length) throw new HttpError(400, "Mỗi cột chỉ được dùng cho một trường.");
  const issues = ["sku", "name", "price"].filter(field => !mapping[field as ImportField]).map(field => `Chọn cột ${field === "sku" ? "SKU" : field === "name" ? "tên sản phẩm" : "giá chào"}.`);
  const items: ImportLine[] = []; const seen = new Set<string>();
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    const line: ImportLine = { row: index, sku: "", name: "", price: "", supplierSku: "", unit: "" };
    try {
      for (const field of importFields) line[field] = cell(row, mapping[field]);
      if (issues.length) return;
      line.sku = requiredText(line.sku, "SKU", 100);
      line.name = requiredText(line.name, "Tên sản phẩm", 255);
      line.unit = line.unit ? requiredText(line.unit, "Đơn vị", 50) : "Cái";
      line.supplierSku = line.supplierSku ? requiredText(line.supplierSku, "Mã hàng NCC", 100) : line.sku;
      line.price = money(line.price, "Giá chào (không dùng dấu phân cách hàng nghìn)").toFixed(2);
      if (seen.has(line.sku)) throw new Error("SKU lặp trong file.");
      seen.add(line.sku);
    } catch (error) { line.error = error instanceof Error ? error.message : "Dữ liệu không hợp lệ."; }
    items.push(line);
  });
  if (!issues.length && !items.length) issues.push("File không có sản phẩm.");
  return { headers, mapping, issues, items };
}
