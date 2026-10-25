// src/modules/products/services/barcode-generator.service.ts
import { prisma } from "../../../shared/infrastructure/database/prisma.client";

function calcEan13CheckDigit(d12: string): string {
  if (!/^\d{12}$/.test(d12)) throw new Error("EAN-13 cần 12 chữ số để tính check digit");
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const n = parseInt(d12[i], 10);
    sum += i % 2 === 0 ? n : n * 3;
  }
  const mod = sum % 10;
  const check = mod === 0 ? 0 : 10 - mod;
  return check.toString();
}

function randomDigits(len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 10).toString();
  return s;
}

function generateCode128Like(): string {
  // Tạm thời sinh dạng alphanumeric ngắn, dễ đọc. 
  // Nếu cần đúng chuẩn Code128 đầy đủ có thể dùng thư viện sau này
  const ts = Date.now().toString().slice(-6);
  const rnd = randomDigits(6);
  return `C128${ts}${rnd}`;
}

export class BarcodeGeneratorService {
  async generate(input: {
    businessId: string;
    type: "EAN13" | "CODE128";
  }): Promise<string> {
    let attempts = 0;
    while (attempts < 50) {
      attempts++;
      let barcode: string;

      if (input.type === "EAN13") {
        // Dải nội bộ gợi ý: 200xxxx...xxx (phù hợp dùng nội bộ)
        const prefix = "200";
        const rest = randomDigits(9); // prefix 3 + rest 9 = 12
        const d12 = prefix + rest;
        const check = calcEan13CheckDigit(d12);
        barcode = d12 + check; // 13 digits
      } else {
        barcode = generateCode128Like();
      }

      const exists = await prisma.productVariant.findFirst({
        where: { businessId: input.businessId, barcode },
        select: { id: true },
      });
      if (!exists) return barcode;
    }
    throw new Error("Không thể sinh Barcode duy nhất sau nhiều lần thử");
  }
}