BEGIN;

ALTER TABLE "online_report_records"
  ADD COLUMN "unmapped_financial_data" JSONB;

UPDATE "online_report_records"
SET
  "financial_data" = COALESCE((
    SELECT jsonb_object_agg(field.key, field.value)
    FROM jsonb_each("online_report_records"."financial_data") AS field
    WHERE field.key IN (
      'sellerReceivedAmount',
      'productGrossAmount',
      'refundAmount',
      'buyerShippingPaid',
      'actualShippingFee',
      'platformShippingSubsidy',
      'returnShippingFee',
      'pishipShippingRefund',
      'failedDeliveryReturnShippingFee',
      'platformProductSubsidy',
      'sellerVoucherDiscount',
      'sellerCoFundedVoucherDiscount',
      'sellerCoinDiscount',
      'sellerCoFundedCoinDiscount',
      'fixedPlatformFee',
      'serviceFee',
      'transactionFee',
      'affiliateFee',
      'pishipServiceFee',
      'automaticTopUp',
      'vat',
      'personalIncomeTax',
      'buyerInstallationFee',
      'actualInstallationFee',
      'sellerTradeInBonus',
      'sellerShippingSupport',
      'lostParcelCompensation',
      'productPaidAfterPromotion',
      'shopeeCoinDiscount',
      'shopeeVoucherDiscount',
      'bankPromotionDiscount',
      'shopeeBankPromotionDiscount',
      'adjustmentAmount',
      'adjustmentType',
      'voucherPackageFee',
      'livePackageFee',
      'experiencePackageFee',
      'shippingPromotionPackageFee',
      'estimatedShippingFee'
    )
  ), '{}'::jsonb),
  "unmapped_financial_data" = COALESCE((
    SELECT jsonb_object_agg(field.key, field.value)
    FROM jsonb_each("online_report_records"."financial_data") AS field
    WHERE field.key NOT IN (
      'sellerReceivedAmount',
      'productGrossAmount',
      'refundAmount',
      'buyerShippingPaid',
      'actualShippingFee',
      'platformShippingSubsidy',
      'returnShippingFee',
      'pishipShippingRefund',
      'failedDeliveryReturnShippingFee',
      'platformProductSubsidy',
      'sellerVoucherDiscount',
      'sellerCoFundedVoucherDiscount',
      'sellerCoinDiscount',
      'sellerCoFundedCoinDiscount',
      'fixedPlatformFee',
      'serviceFee',
      'transactionFee',
      'affiliateFee',
      'pishipServiceFee',
      'automaticTopUp',
      'vat',
      'personalIncomeTax',
      'buyerInstallationFee',
      'actualInstallationFee',
      'sellerTradeInBonus',
      'sellerShippingSupport',
      'lostParcelCompensation',
      'productPaidAfterPromotion',
      'shopeeCoinDiscount',
      'shopeeVoucherDiscount',
      'bankPromotionDiscount',
      'shopeeBankPromotionDiscount',
      'adjustmentAmount',
      'adjustmentType',
      'voucherPackageFee',
      'livePackageFee',
      'experiencePackageFee',
      'shippingPromotionPackageFee',
      'estimatedShippingFee'
    )
  ), '{}'::jsonb)
WHERE "financial_data" IS NOT NULL;

COMMIT;
