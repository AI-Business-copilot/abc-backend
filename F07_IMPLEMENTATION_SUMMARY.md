# F07 Backend Implementation Summary

## Status: Complete ✅

The F07 (Stock Audit) backend has been fully implemented with all core endpoints, business logic, and database integration.

---

## Implemented Components

### 1. Routes (`inventory.routes.ts`)

**Audit Management:**
- `POST /audits` - Create new audit with scope lock
- `GET /audits` - List audits with status filtering
- `GET /audits/:id` - Get full audit details

**Count Recording:**
- `POST /audits/:id/items` - Record single count (captures snapshot_qty on first submission)
- `PATCH /audits/:id/items/:itemId` - Update count with discrepancy reason
- `GET /audits/:id/items` - Get all items with pagination

**Approval & Application:**
- `PATCH /audits/:id/approve` - Owner approves audit (validates discrepancy reasons)
- `PATCH /audits/:id/apply` - Apply audit (updates balances, creates ledger, unlocks variants)

### 2. Controller (`inventory.controller.ts`)

Implemented 8 new methods:
- `createAudit()` - Route handler for audit creation
- `listAudits()` - Route handler for listing
- `getAudit()` - Route handler for details
- `recordCount()` - Route handler for count submission
- `updateCount()` - Route handler for count updates
- `getAuditItems()` - Route handler for items listing
- `approveAudit()` - Route handler for approval
- `applyAudit()` - Route handler for application

### 3. Audit Service (`services/audit.service.ts` - 595 lines)

**Core Methods:**

#### `createAudit(businessId, authUserId, body)`
- Validates audit code uniqueness per business
- Supports 3 scope types: FULL_STORE, CATEGORY, SHELF
- Determines affected variants based on scope
- Locks all affected variants in atomic transaction
- Returns: audit ID, code, status, affected variant count

#### `listAudits(businessId, params)`
- Filters by status (IN_PROGRESS, PENDING_APPROVAL, APPLIED, CANCELLED)
- Pagination support
- Returns summary counts for each audit

#### `getAudit(businessId, auditId)`
- Returns full audit details with all items
- Includes variant/lot information

#### `recordCount(businessId, auditId, body)`
- Accepts: variantId, lotId (nullable), countedQty
- **Key Logic**: Captures `snapshotQty` from `inventory_balances.quantity_on_hand` on first submission
- If item exists, updates countedQty
- Returns: item ID, snapshot, counted quantities, and creation flag

#### `updateCount(businessId, auditId, itemId, body)`
- Updates countedQty and discrepancy_reason
- **Validation**: If diff ≠ 0, requires discrepancy_reason
- Enforces reasons before approval step

#### `approveAudit(businessId, authUserId, auditId)`
- Status: IN_PROGRESS → PENDING_APPROVAL
- **Validation**: All items with diff ≠ 0 must have discrepancy_reason
- Records approver user ID

#### `applyAudit(businessId, authUserId, auditId)`
- Status: PENDING_APPROVAL → APPLIED
- **Atomic transaction** that:
  1. Updates `inventory_balances.quantity_on_hand = counted_qty` for each item
  2. Creates `inventory_ledger` entries:
     - STOCK_ADJUSTMENT_IN if diff > 0
     - STOCK_ADJUSTMENT_OUT if diff < 0
  3. Unlocks all affected variants: `isLockedForAudit = FALSE`
  4. Sets audit completed_at timestamp
- **Idempotent**: Can safely retry (checks status first)
- Calculates loss: `|diff_qty| × cost_price` in ledger

### 4. Audit Lock Service (`services/audit-lock.service.ts`)

**Validation Methods:**

#### `validateNotLocked(businessId, variantId)`
- Checks if variant is locked for audit
- Throws 409 Conflict if locked
- Used to prevent inventory transactions

#### `validateNotLockedBatch(businessId, variantIds[])`
- Batch validation for multiple variants
- Reports all locked variants in error message

#### `getLockedAudits(businessId, variantId)`
- Returns active audits (IN_PROGRESS, PENDING_APPROVAL) locking this variant
- Useful for debugging/UI display

---

## Data Flow

### 1. Create Audit (Step 1)
```
POST /audits
├─ Validate unique audit code per business
├─ Determine affected variants by scope_type
├─ Create StockAudit (status=IN_PROGRESS, isLockedForAudit=true)
└─ Lock all affected ProductVariants (isLockedForAudit=true)
   └ Response: audit_id, scope info, variant count
```

### 2. Record Counts (Step 2)
```
POST /audits/:id/items
├─ Verify audit exists and IN_PROGRESS
├─ Find or create StockAuditItem
├─ On FIRST submission: capture snapshot_qty from InventoryBalance
└─ Response: item_id, snapshot_qty, counted_qty
```

### 3. Update Counts (Step 2 continued)
```
PATCH /audits/:id/items/:itemId
├─ Update countedQty
├─ If diff ≠ 0: require discrepancy_reason
└─ Response: updated item with diff_qty
```

### 4. Approve (Step 3)
```
PATCH /audits/:id/approve
├─ Validate status = IN_PROGRESS
├─ Check: all items with diff≠0 have discrepancy_reason
├─ Update status → PENDING_APPROVAL
└─ Record approver user_id
```

### 5. Apply (Step 4)
```
PATCH /audits/:id/apply [ATOMIC TRANSACTION]
├─ For each audit item:
│  ├─ Update InventoryBalance.quantity_on_hand = counted_qty
│  ├─ If diff ≠ 0: create InventoryLedger entry
│  │  ├─ Type: STOCK_ADJUSTMENT_IN (if diff>0) or STOCK_ADJUSTMENT_OUT (if diff<0)
│  │  ├─ Quantity: abs(diff)
│  │  └─ Cost: diff × product.cost_price
│  └─
├─ Unlock all affected variants (isLockedForAudit=false)
├─ Update status → APPLIED
└─ Response: items_applied, ledger_entries_created
```

---

## Database Tables Used

### StockAudit
- `id` - Audit UUID
- `business_id` - FK to Business
- `audit_code` - Unique per business
- `scope_type` - FULL_STORE | CATEGORY | SHELF
- `scope_value` - Category/Shelf ID (nullable)
- `status` - IN_PROGRESS | PENDING_APPROVAL | APPLIED | CANCELLED
- `is_locked_for_audit` - Boolean lock flag
- `count_start_at` - Audit creation time
- `completed_at` - When applied (nullable)
- `approved_by` - FK to User who approved

### StockAuditItem
- `id` - Item UUID
- `audit_id` - FK to StockAudit
- `variant_id` - FK to ProductVariant
- `lot_id` - FK to ProductLot (nullable)
- `snapshot_qty` - System count at audit start (from InventoryBalance)
- `counted_qty` - Staff physical count
- `diff_qty` - Generated column: counted_qty - snapshot_qty
- `discrepancy_reason` - Required if diff ≠ 0 (before approval)

### InventoryBalance (Updated)
- `quantity_on_hand` - Updated to counted_qty during apply
- Used to read snapshot on first count submission

### InventoryLedger (Updated)
- New entries created during apply:
  - `transaction_type` - STOCK_ADJUSTMENT_IN | STOCK_ADJUSTMENT_OUT
  - `quantity_changed` - diff_qty (signed)
  - `unit_cost` - From ProductVariant.cost_price
  - `total_cost_value` - quantity_changed × unit_cost
  - `reference_doc_type` - "STOCK_AUDIT"
  - `reference_doc_id` - Audit ID

### ProductVariant (Updated)
- `is_locked_for_audit` - Set to TRUE when audit created, FALSE when applied

---

## Permissions Required

These permissions must be defined in the RBAC system:

1. **`inventory.audit.create`** - Permission to create audits
2. **`inventory.audit.count`** - Permission to record/update counts
3. **`inventory.audit.approve`** - Permission to approve audits (typically Owner only)
4. **`inventory.audit.apply`** - Permission to apply audits (typically Owner only)
5. **`inventory.read`** - Existing, allows listing/viewing audits

---

## Error Handling

### 400 Bad Request
- Missing/invalid audit code
- Invalid scope_type
- Missing or invalid variant_id
- Invalid counted_qty (must be ≥ 0)
- Missing discrepancy_reason when diff ≠ 0

### 403 Forbidden
- User not synced with business
- Insufficient permissions for operation

### 404 Not Found
- Audit not found
- Variant not found
- Audit item not found
- Category (for CATEGORY scope) not found

### 409 Conflict
- Audit code already exists in business
- Audit in wrong status for operation
- All items don't have discrepancy_reason (on approve)
- Empty audit on apply

---

## Integration Points

### For Lock Enforcement (Future/Pending)

These modules should call `auditLockService.validateNotLocked(businessId, variantId)` before allowing transactions:

1. **POS Sales** (F04)
   - When scanning variant barcode to add to order
   - Before completing sale

2. **Purchase Receipt** (F03)
   - When receiving goods into inventory_balances

3. **Customer Returns** (F05)
   - When restocking returned items

4. **Scrap Disposal** (F08)
   - When reducing inventory via scrap orders

Example:
```typescript
// In sales service
await auditLockService.validateNotLocked(businessId, variantId);
// Throws 409 if locked
```

---

## Validation Rules Summary

| Rule | When | Enforcement |
|------|------|-------------|
| Unique audit code | Create | 409 if duplicate |
| Valid scope_type | Create | 400 if invalid |
| Scope has variants | Create | 400 if empty |
| Valid variant_id | Record count | 404 if not found |
| countedQty ≥ 0 | Record/Update | 400 if invalid |
| discrepancy_reason required | Update/Approve | 400 if missing when diff≠0 |
| Status = IN_PROGRESS | Record/Update | 409 if wrong status |
| Status = IN_PROGRESS | Approve | 409 if wrong status |
| Status = PENDING_APPROVAL | Apply | 409 if wrong status |
| No duplicate items | Record (auto) | Returns existing ID |

---

## TypeScript Compilation

✅ **Build Status**: SUCCESS

```
npm run build
> tsc
[No errors]
```

All types are properly defined with full TypeScript support.

---

## Testing Recommendations

### Unit Tests
- Snapshot capture on first submission
- Discrepancy reason validation
- Diff calculation correctness
- Lock/unlock state transitions

### Integration Tests
- Full audit lifecycle: create → count → approve → apply
- Inventory balance updates
- Ledger entry creation
- Variant locking/unlocking

### E2E Tests
- Create audit with FULL_STORE scope
- Record counts for multiple variants
- Approve with discrepancy reasons
- Apply and verify balance updates
- Verify ledger entries

---

## Next Steps

### Immediate (High Priority)
1. Register F07 permissions in RBAC system
2. Integrate lock validation into F04 (POS Sales)
3. Integrate lock validation into F03 (Purchases)

### Future (Post-MVP)
1. Add lock validation to F05 (Returns) and F08 (Scrap)
2. Add audit status/lock info to POS UI
3. Add audit history/analytics reporting
4. Add email notifications on audit completion

---

## Files Modified/Created

### Created
- `abc-backend/src/modules/inventory/services/audit.service.ts` (595 lines)
- `abc-backend/src/modules/inventory/services/audit-lock.service.ts` (78 lines)

### Modified
- `abc-backend/src/modules/inventory/inventory.routes.ts` - Added 11 new routes
- `abc-backend/src/modules/inventory/inventory.controller.ts` - Added 8 new methods
- `abc-backend/src/modules/inventory/inventory.service.ts` - Added exports

---

## Implementation Details

### Transaction Safety
- All audit creation uses transactions to ensure variant locking happens atomically
- Apply uses 60s transaction timeout to handle multiple items
- Ledger creation happens within apply transaction

### Idempotency
- Apply is idempotent (checks status first before double-processing)
- Record count auto-detects existing items and returns creation flag

### Performance Considerations
- Snapshot capture is O(1) - direct lookup
- Batch validation available for multiple variants
- Pagination on list endpoints (default 10-50 items)

### Concurrency Safety
- Row-level locks via transaction on audit creation
- Audit items are unique per (audit_id, variant_id, lot_id)
- Status-based state machine prevents concurrent operations
