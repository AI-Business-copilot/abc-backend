// Types for the F08 disposal dossier (Thông tư 78/2014, amended by Thông tư 96/2015).
// The dossier is the set of documents a business must keep to deduct a loss of expired or
// damaged goods from its corporate income tax.

/**
 * The cause of the loss as stated in the dossier. EXPIRED and DAMAGED_TRANSIT are the natural
 * biochemical change the tax rules accept without further justification; QUALITY_FAIL and
 * OLD_STOCK need their own justification in the dossier.
 */
export const SCRAP_CAUSE_CODES = ["EXPIRED", "DAMAGED_TRANSIT", "QUALITY_FAIL", "OLD_STOCK"] as const;
export type ScrapCauseCode = (typeof SCRAP_CAUSE_CODES)[number];

/** How the goods were destroyed. */
export const DISPOSAL_METHODS = ["INCINERATION", "BURIAL", "CHEMICAL", "CONTRACTOR"] as const;
export type DisposalMethod = (typeof DISPOSAL_METHODS)[number];

/** Vietnamese labels, so the raw code never reaches the user. */
export const scrapCauseCodeLabel: Record<ScrapCauseCode, string> = {
  EXPIRED: "Hết hạn sử dụng",
  DAMAGED_TRANSIT: "Hư hỏng trong vận chuyển",
  QUALITY_FAIL: "Không đạt chất lượng",
  OLD_STOCK: "Tồn kho lâu ngày",
};

export const disposalMethodLabel: Record<DisposalMethod, string> = {
  INCINERATION: "Đốt cháy",
  BURIAL: "Chôn lập",
  CHEMICAL: "Hóa chất",
  CONTRACTOR: "Thuê đơn vị tiêu hủy",
};

/** The minimum number of witnesses the council must have. */
export const MIN_DISPOSAL_WITNESSES = 2;

/** One row of the bảng kê xuất nhập tồn that the tax dossier must carry. */
export interface DossierLedgerLine {
  date: string;
  transactionType: string;
  quantity: number;
  unitCost: number;
  totalValue: number;
  note: string;
}

/** The dossier as the backend assembles it. The frontend turns it into a printable PDF. */
export interface DisposalDossierReport {
  scrapCode: string;
  businessName: string;
  businessAddress: string | null;
  step1_council: {
    leader: string;
    accountant: string | null;
    createdDate: string | null;
  };
  step2_inspection: {
    productName: string;
    sku: string;
    lotNumber: string | null;
    expiryDate: string | null;
    quantity: number;
    unitCost: number;
    totalValue: number;
    /** The condition of the goods (the lot status). The cause of the loss is stated in step 3. */
    condition: string;
    createdDate: string | null;
  };
  step3_decision: {
    causeCode: ScrapCauseCode | null;
    disposalMethod: DisposalMethod | null;
    disposalLocation: string | null;
    approvedBy: string | null;
    approvedDate: string | null;
    witnesses: string[];
  };
  step4_execution: {
    status: string;
  };
  step5_disposal: {
    actualDate: string | null;
    confirmedBy: string | null;
  };
  step6_archive_bangke: {
    bangKeXuatNhapTon: DossierLedgerLine[];
  };
  tax_fields: {
    totalLossValue: number;
    compensatedAmount: number;
    deductibleLoss: number;
    taxLegislation: string;
  };
}
