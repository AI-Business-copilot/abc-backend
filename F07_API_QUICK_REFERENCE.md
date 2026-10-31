# F07 Stock Audit API Quick Reference

## Base URL
```
/inventory/audits
```

## Authentication
All endpoints require:
- Supabase authentication (`requireSupabaseIdentity`)
- Business scope (`requireBusinessScope`)
- Appropriate permission

---

## 1. Create Audit

**Endpoint:** `POST /audits`

**Permission:** `inventory.audit.create`

**Request Body:**
```json
{
  "auditCode": "AUDIT-2026-10-001",
  "scopeType": "FULL_STORE",
  "scopeValue": null,
  "note": "Monthly inventory check"
}
```

**Scope Types:**
- `FULL_STORE` - Audit entire store (no scopeValue needed)
- `CATEGORY` - Audit specific category (scopeValue = category_id)
- `SHELF` - Audit specific shelf (scopeValue = shelf_id)

**Response (201 Created):**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "auditCode": "AUDIT-2026-10-001",
  "scopeType": "FULL_STORE",
  "status": "IN_PROGRESS",
  "isLockedForAudit": true,
  "countStartAt": "2026-10-29T08:00:00Z",
  "affectedVariantCount": 150
}
```

**Errors:**
- `400` - Invalid scope_type, missing auditCode, or empty variant list
- `409` - Audit code already exists

---

## 2. List Audits

**Endpoint:** `GET /audits`

**Permission:** `inventory.read`

**Query Parameters:**
```
?status=IN_PROGRESS&page=1&pageSize=10
```

Status options: `IN_PROGRESS`, `PENDING_APPROVAL`, `APPLIED`, `CANCELLED`

**Response:**
```json
{
  "items": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "auditCode": "AUDIT-2026-10-001",
      "scopeType": "FULL_STORE",
      "status": "IN_PROGRESS",
      "itemCount": 45,
      "isLockedForAudit": true,
      "countStartAt": "2026-10-29T08:00:00Z",
      "completedAt": null,
      "approvedBy": null
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 10,
    "total": 1,
    "totalPages": 1
  }
}
```

---

## 3. Get Audit Details

**Endpoint:** `GET /audits/:id`

**Permission:** `inventory.read`

**Response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "auditCode": "AUDIT-2026-10-001",
  "scopeType": "FULL_STORE",
  "status": "IN_PROGRESS",
  "isLockedForAudit": true,
  "countStartAt": "2026-10-29T08:00:00Z",
  "completedAt": null,
  "approvedBy": null,
  "itemCount": 2,
  "items": [
    {
      "id": "660e8400-e29b-41d4-a716-446655440001",
      "variantId": "v-001",
      "lotId": null,
      "snapshotQty": 100,
      "countedQty": 98,
      "diffQty": -2,
      "discrepancyReason": null
    }
  ]
}
```

---

## 4. Record Count (Create New Item)

**Endpoint:** `POST /audits/:id/items`

**Permission:** `inventory.audit.count`

**Request Body:**
```json
{
  "variantId": "v-001",
  "lotId": null,
  "countedQty": 98
}
```

**Response (201 Created):**
```json
{
  "id": "660e8400-e29b-41d4-a716-446655440001",
  "created": true,
  "snapshotQty": 100,
  "countedQty": 98
}
```

**Notes:**
- On first submission: `snapshot_qty` captured from current `inventory_balances.quantity_on_hand`
- `lotId` required only for lot-tracked products
- `countedQty` must be ≥ 0

**Errors:**
- `404` - Audit or variant not found
- `409` - Audit not IN_PROGRESS status
- `400` - Invalid counted_qty

---

## 5. Update Count (Including Discrepancy Reason)

**Endpoint:** `PATCH /audits/:id/items/:itemId`

**Permission:** `inventory.audit.count`

**Request Body:**
```json
{
  "countedQty": 97,
  "discrepancyReason": "Found 1 damaged item in corner, 1 missing tag"
}
```

**Response:**
```json
{
  "id": "660e8400-e29b-41d4-a716-446655440001",
  "snapshotQty": 100,
  "countedQty": 97,
  "diffQty": -3,
  "discrepancyReason": "Found 1 damaged item in corner, 1 missing tag"
}
```

**Validation:**
- If `diffQty ≠ 0`: `discrepancyReason` is **REQUIRED**
- Reason max 1000 characters

**Errors:**
- `400` - Missing discrepancy_reason when diff ≠ 0
- `409` - Audit not IN_PROGRESS

---

## 6. Get Audit Items (Paginated)

**Endpoint:** `GET /audits/:id/items`

**Permission:** `inventory.read`

**Query Parameters:**
```
?page=1&pageSize=20
```

**Response:**
```json
{
  "items": [
    {
      "id": "660e8400-e29b-41d4-a716-446655440001",
      "variantId": "v-001",
      "sku": "POLO-S-BLK",
      "productName": "Polo Shirt",
      "imageUrl": "https://...",
      "attributeText": "Size: S · Color: Black",
      "lotId": null,
      "lotNumber": null,
      "expirationDate": null,
      "snapshotQty": 100,
      "countedQty": 97,
      "diffQty": -3,
      "discrepancyReason": "Found 1 damaged + 2 missing"
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 20,
    "total": 45,
    "totalPages": 3
  }
}
```

---

## 7. Approve Audit

**Endpoint:** `PATCH /audits/:id/approve`

**Permission:** `inventory.audit.approve` (typically Owner only)

**Request Body:** Empty or `{}`

**Response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "auditCode": "AUDIT-2026-10-001",
  "status": "PENDING_APPROVAL",
  "approvedBy": "Nguyễn Văn A"
}
```

**Validation:**
- Audit must be IN_PROGRESS
- **All items with `diffQty ≠ 0` must have `discrepancyReason`**

**Errors:**
- `409` - Audit not IN_PROGRESS or missing discrepancy reasons
- `400` - Audit has no items

---

## 8. Apply Audit

**Endpoint:** `PATCH /audits/:id/apply`

**Permission:** `inventory.audit.apply` (typically Owner only)

**Request Body:** Empty or `{}`

**Response (201):**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "auditCode": "AUDIT-2026-10-001",
  "status": "APPLIED",
  "itemsApplied": 45,
  "ledgerEntriesCreated": 12
}
```

**What Happens:**
1. ✅ Updates `inventory_balances.quantity_on_hand = counted_qty` for each item
2. ✅ Creates `inventory_ledger` entries for each difference:
   - `STOCK_ADJUSTMENT_IN` if counted > snapshot
   - `STOCK_ADJUSTMENT_OUT` if counted < snapshot
3. ✅ Unlocks all affected variants (removes kho lock)
4. ✅ Sets audit status to `APPLIED`

**Errors:**
- `409` - Audit not PENDING_APPROVAL status
- `409` - Already applied (idempotent, safe to retry)

---

## Complete Workflow Example

### 1. Create Audit
```bash
curl -X POST http://localhost:3000/inventory/audits \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{
    "auditCode": "AUDIT-2026-10-001",
    "scopeType": "FULL_STORE"
  }'
```

### 2. Record Counts (staff scans items)
```bash
curl -X POST http://localhost:3000/inventory/audits/{auditId}/items \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{
    "variantId": "v-001",
    "countedQty": 98
  }'
```

### 3. Update with Reason (if diff detected)
```bash
curl -X PATCH http://localhost:3000/inventory/audits/{auditId}/items/{itemId} \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{
    "countedQty": 98,
    "discrepancyReason": "Found 2 damaged items"
  }'
```

### 4. Approve (owner reviews and approves)
```bash
curl -X PATCH http://localhost:3000/inventory/audits/{auditId}/approve \
  -H "Authorization: Bearer {token}"
```

### 5. Apply (owner finalizes)
```bash
curl -X PATCH http://localhost:3000/inventory/audits/{auditId}/apply \
  -H "Authorization: Bearer {token}"
```

---

## Error Response Format

All errors follow this format:

```json
{
  "message": "Mã kiểm kê \"AUDIT-2026-10-001\" đã tồn tại trong cửa hàng này."
}
```

HTTP Status Codes:
- `400` - Bad Request (validation error)
- `403` - Forbidden (insufficient permissions)
- `404` - Not Found
- `409` - Conflict (wrong status or duplicate)
- `500` - Internal Server Error

---

## Important Notes

### Kho Locking
- When audit is created with scope, **all affected variants are locked**
- While locked, these variants **cannot be involved in sales, purchases, returns, or scrap**
- Lock is **automatically released** when audit is applied
- Prevents data inconsistency during counting

### Snapshot Quantity
- Captured automatically on **first count submission** for each variant/lot
- Represents the "system count" at audit start time
- Read from `inventory_balances.quantity_on_hand`
- Cannot be manually changed

### Discrepancy Reasons
- **REQUIRED** if counted ≠ snapshot (diff ≠ 0)
- Must be provided before approval
- Examples:
  - "Rách hỏng 1 cái ở góc kệ" (1 damaged in corner)
  - "Nhập nhầm size" (Wrong size entered)
  - "Hàng còn chưa lấy từ kho" (Still in warehouse)

### Ledger Integration
- Audit differences automatically create ledger entries
- Ledger records loss/gain calculations for accounting
- Used for P&L reporting

---

## Performance Tips

1. **Batch Recording** - Staff can record counts one by one or in bulk
2. **Pagination** - List items paginated (default 20 per page)
3. **Status Filtering** - Use status filter to find active audits quickly
4. **Snapshot is O(1)** - Very fast even for large inventories
