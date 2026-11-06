INSERT INTO "cash_transactions" (
  "business_id",
  "shift_id",
  "transaction_type",
  "category",
  "amount",
  "ref_doc_type",
  "ref_doc_id",
  "recipient_or_payer",
  "notes",
  "created_by",
  "created_at"
)
SELECT
  o."business_id",
  p."shift_id",
  'IN',
  'POS_SALE',
  p."amount",
  'ORDER',
  o."id",
  COALESCE(c."name", 'Khách lẻ'),
  'Thu tiền mặt hóa đơn ' || o."order_code",
  o."cashier_id",
  COALESCE(p."created_at", o."created_at", CURRENT_TIMESTAMP)
FROM "order_payments" p
JOIN "orders" o ON o."id" = p."order_id"
LEFT JOIN "customers" c ON c."id" = o."customer_id"
WHERE o."status" = 'COMPLETED'
  AND p."payment_method" = 'CASH'
  AND NOT EXISTS (
    SELECT 1
      FROM "cash_transactions" ct
     WHERE ct."shift_id" = p."shift_id"
       AND ct."ref_doc_type" = 'ORDER'
       AND ct."ref_doc_id" = o."id"
       AND ct."category" IN ('POS_SALE', 'SALE_CASH')
       AND ct."transaction_type" = 'IN'
  );

INSERT INTO "cash_transactions" (
  "business_id",
  "shift_id",
  "transaction_type",
  "category",
  "amount",
  "ref_doc_type",
  "ref_doc_id",
  "recipient_or_payer",
  "notes",
  "created_by",
  "created_at"
)
SELECT
  r."business_id",
  r."shift_id",
  'OUT',
  'CUSTOMER_REFUND',
  r."total_refund_amount",
  'CUSTOMER_RETURN',
  r."id",
  'Khách hàng',
  'Hoàn tiền mặt phiếu ' || r."return_code",
  r."cashier_id",
  COALESCE(r."created_at", CURRENT_TIMESTAMP)
FROM "customer_returns" r
WHERE r."status" = 'COMPLETED'
  AND r."refund_method" = 'CASH'
  AND r."total_refund_amount" > 0
  AND NOT EXISTS (
    SELECT 1
      FROM "cash_transactions" ct
     WHERE ct."shift_id" = r."shift_id"
       AND ct."ref_doc_type" = 'CUSTOMER_RETURN'
       AND ct."ref_doc_id" = r."id"
       AND ct."category" = 'CUSTOMER_REFUND'
       AND ct."transaction_type" = 'OUT'
  );

UPDATE "cash_shifts" s
   SET "reconciliation_status" = CASE
     WHEN EXISTS (
       SELECT 1
         FROM "orders" o
        WHERE o."shift_id" = s."id"
          AND o."status" = 'COMPLETED'
          AND NOT EXISTS (
            SELECT 1 FROM "order_payments" p WHERE p."order_id" = o."id"
          )
     )
     OR EXISTS (
       SELECT 1
         FROM "order_payments" p
        WHERE p."shift_id" = s."id"
          AND p."payment_method" = 'CASH'
          AND NOT EXISTS (
            SELECT 1
              FROM "cash_transactions" ct
             WHERE ct."shift_id" = p."shift_id"
               AND ct."ref_doc_type" = 'ORDER'
               AND ct."ref_doc_id" = p."order_id"
               AND ct."category" IN ('POS_SALE', 'SALE_CASH')
               AND ct."transaction_type" = 'IN'
          )
     )
     OR EXISTS (
       SELECT 1
         FROM "customer_returns" r
        WHERE r."shift_id" = s."id"
          AND r."status" = 'COMPLETED'
          AND r."refund_method" = 'CASH'
          AND r."total_refund_amount" > 0
          AND NOT EXISTS (
            SELECT 1
              FROM "cash_transactions" ct
             WHERE ct."shift_id" = r."shift_id"
               AND ct."ref_doc_type" = 'CUSTOMER_RETURN'
               AND ct."ref_doc_id" = r."id"
               AND ct."category" = 'CUSTOMER_REFUND'
               AND ct."transaction_type" = 'OUT'
          )
     )
     THEN 'INCOMPLETE_DATA'
     ELSE 'RECONCILED'
   END
 WHERE s."status" = 'CLOSED';
