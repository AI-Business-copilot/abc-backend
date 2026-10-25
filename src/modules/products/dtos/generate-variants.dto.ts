// src/modules/products/dtos/generate-variants.dto.ts
export interface GenerateVariantsBody {
  businessId: string;
  // Danh sách thuộc tính dùng để sinh tổ hợp. Có thể bỏ trống nếu sản phẩm đơn
  attributes?: Array<{
    attributeId: string;
    attributeValueIds: string[];
  }>;
  // Thông tin mặc định áp dụng cho toàn bộ biến thể sinh ra
  defaults?: {
    basePrice?: number | string;
    costPrice?: number | string;
    isActive?: boolean; // mặc định true -> ACTIVE
  };
  // Tuỳ chọn: chọn loại barcode muốn sinh (ưu tiên EAN-13 theo hướng KiotViet)
  barcodeType?: "EAN13" | "CODE128";
}