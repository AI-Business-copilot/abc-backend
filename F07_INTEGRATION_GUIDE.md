# F07 Backend Implementation Checklist & Integration Guide

## ✅ Core Implementation Status

### Completed Tasks
- [x] **Routes Setup** - 11 F07 endpoints registered in `inventory.routes.ts`
- [x] **Controller Methods** - 8 new controller methods in `inventory.controller.ts`
- [x] **Audit Service** - Full `audit.service.ts` with all business logic (595 lines)
- [x] **Lock Service** - `audit-lock.service.ts` for preventing concurrent transactions (78 lines)
- [x] **TypeScript Build** - ✅ Compiles without errors
- [x] **Error Handling** - Comprehensive validation and HTTP error codes
- [x] **Transaction Safety** - Atomic operations with proper rollback
- [x] **Permissions Integration** - Permission checks in all routes

### Pending Tasks (Post-MVP)
- [ ] **Lock Enforcement in F04 (POS Sales)** - Validate variants not locked before sale
- [ ] **Lock Enforcement in F03 (Purchases)** - Validate variants not locked before receipt
- [ ] **RBAC Registration** - Define permissions in permission system
- [ ] **Lock Enforcement in F05 (Returns)** - Validate before restocking
- [ ] **Lock Enforcement in F08 (Scrap)** - Validate before scrap disposal

---

## 📋 Integration Checklist for Other Modules

### When Building Sales/POS Module (F04)

Add to order creation service:

```typescript
import { auditLockService } from "../inventory/services/audit-lock.service";

// Before allowing sale on a variant
async function validateVariantForSale(businessId: string, variantId: string) {
  await auditLockService.validateNotLocked(businessId, variantId);
  // Throws 409 if locked - prevents sale during audit
}

// Usage in order controller/service:
async createOrder(businessId: string, items: OrderItem[]) {
  // Validate all variants before creating order
  const variantIds = items.map(item => item.variantId);
  await auditLockService.validateNotLockedBatch(businessId, variantIds);
  
  // Proceed with order creation...
}
```

### When Building Purchase Module (F03)

Add to purchase receipt service:

```typescript
import { auditLockService } from "../inventory/services/audit-lock.service";

// Before accepting purchase receipt
async function validatePurchaseReceipt(businessId: string, variantIds: string[]) {
  await auditLockService.validateNotLockedBatch(businessId, variantIds);
}
```

### When Building Returns Module (F05)

Add to return service:

```typescript
// Before restocking returned items
async function validateReturnForRestock(businessId: string, variantId: string) {
  await auditLockService.validateNotLocked(businessId, variantId);
}
```

### When Building Scrap Module (F08)

Add to scrap order service:

```typescript
// Before creating scrap order
async function validateScrapCreation(businessId: string, variantId: string) {
  await auditLockService.validateNotLocked(businessId, variantId);
}
```

---

## 🔐 RBAC Permissions to Register

The following permissions must be registered in your RBAC/permission system:

```json
{
  "permissions": [
    {
      "id": "inventory.audit.create",
      "name": "Tạo đợt kiểm kê",
      "description": "Tạo đợt kiểm kê hàng hóa",
      "category": "Inventory",
      "roles": ["Manager", "Owner"]
    },
    {
      "id": "inventory.audit.count",
      "name": "Ghi nhận số đếm",
      "description": "Ghi nhận và cập nhật số lượng đếm trong đợt kiểm kê",
      "category": "Inventory",
      "roles": ["Staff", "Manager", "Owner"]
    },
    {
      "id": "inventory.audit.approve",
      "name": "Duyệt đợt kiểm kê",
      "description": "Duyệt kết quả kiểm kê (chuyển sang PENDING_APPROVAL)",
      "category": "Inventory",
      "roles": ["Manager", "Owner"]
    },
    {
      "id": "inventory.audit.apply",
      "name": "Áp dụng kết quả kiểm kê",
      "description": "Cân bằng kho theo kết quả kiểm kê (chuyển sang APPLIED)",
      "category": "Inventory",
      "roles": ["Owner"]
    }
  ]
}
```

---

## 🧪 Testing Scenarios

### Unit Test Cases

#### Test: Create Audit - Full Store
```typescript
it("should create audit with FULL_STORE scope", async () => {
  const result = await auditService.createAudit(businessId, userId, {
    auditCode: "TEST-001",
    scopeType: "FULL_STORE"
  });
  
  expect(result.status).toBe("IN_PROGRESS");
  expect(result.isLockedForAudit).toBe(true);
  expect(result.affectedVariantCount).toBeGreaterThan(0);
});
```

#### Test: Snapshot Capture on First Submission
```typescript
it("should capture snapshot from inventory_balance on first count", async () => {
  // Create balance with qty 100
  await createInventoryBalance(variantId, 100);
  
  const result = await auditService.recordCount(businessId, auditId, {
    variantId,
    countedQty: 98
  });
  
  expect(result.snapshotQty).toBe(100);
  expect(result.created).toBe(true);
});
```

#### Test: Discrepancy Reason Required
```typescript
it("should require discrepancy reason when diff !== 0", async () => {
  await recordCount(variantId, 98); // snapshot 100, count 98
  
  // Should fail without reason
  expect(() => {
    updateCount(itemId, { countedQty: 98 });
  }).toThrow("Bắt buộc phải nhập lý do");
});
```

#### Test: Approval Validation
```typescript
it("should reject approval when items missing discrepancy reasons", async () => {
  await recordCount(variantId, 98); // diff = -2, no reason
  
  expect(() => {
    auditService.approveAudit(businessId, userId, auditId);
  }).toThrow("lý do chưa được nhập");
});
```

#### Test: Apply Updates Balances & Creates Ledger
```typescript
it("should update balances and create ledger on apply", async () => {
  await recordCount(v1, 98); // diff = -2
  await recordCount(v2, 105); // diff = +5
  await approveAudit();
  
  const result = await auditService.applyAudit(businessId, userId, auditId);
  
  expect(result.itemsApplied).toBe(2);
  expect(result.ledgerEntriesCreated).toBe(2);
  
  // Verify balances updated
  const b1 = await getBalance(v1);
  expect(b1.quantityOnHand).toBe(98);
  
  // Verify ledger entries
  const entries = await getLedgerEntries(auditId);
  expect(entries).toHaveLength(2);
  expect(entries[0].transactionType).toBe("STOCK_ADJUSTMENT_OUT");
  expect(entries[1].transactionType).toBe("STOCK_ADJUSTMENT_IN");
});
```

#### Test: Variant Locking
```typescript
it("should lock affected variants on audit create", async () => {
  await createAudit("FULL_STORE");
  
  const variant = await getVariant(variantId);
  expect(variant.isLockedForAudit).toBe(true);
});

it("should unlock variants on audit apply", async () => {
  await createAudit("FULL_STORE");
  await recordCount(variantId, 100);
  await approveAudit();
  await applyAudit();
  
  const variant = await getVariant(variantId);
  expect(variant.isLockedForAudit).toBe(false);
});
```

### Integration Test Cases

#### Test: Complete Audit Lifecycle
```typescript
describe("F07 Complete Audit Lifecycle", () => {
  it("should handle full audit flow: create -> count -> approve -> apply", async () => {
    // 1. Create
    const audit = await auditService.createAudit(businessId, userId, {
      auditCode: "INT-001",
      scopeType: "FULL_STORE"
    });
    expect(audit.status).toBe("IN_PROGRESS");
    
    // 2. Record counts
    await auditService.recordCount(businessId, audit.id, {
      variantId: "v1",
      countedQty: 98
    });
    
    // 3. Update with reason
    const items = await auditService.getAuditItems(businessId, audit.id, {});
    await auditService.updateCount(businessId, audit.id, items.items[0].id, {
      countedQty: 98,
      discrepancyReason: "2 damaged items found"
    });
    
    // 4. Approve
    const approved = await auditService.approveAudit(businessId, userId, audit.id);
    expect(approved.status).toBe("PENDING_APPROVAL");
    
    // 5. Apply
    const applied = await auditService.applyAudit(businessId, userId, audit.id);
    expect(applied.status).toBe("APPLIED");
    expect(applied.ledgerEntriesCreated).toBe(1);
  });
});
```

#### Test: Lock Enforcement
```typescript
describe("F07 Lock Enforcement", () => {
  it("should prevent sales during audit", async () => {
    await createAudit("FULL_STORE");
    
    // Try to create sale
    expect(() => {
      validateNotLocked(businessId, variantId);
    }).toThrow("đang bị khóa trong quá trình kiểm kê");
  });
  
  it("should allow sales after audit applied", async () => {
    await createAudit("FULL_STORE");
    await recordCount(variantId, 100);
    await approveAudit();
    await applyAudit();
    
    // Sale should be allowed
    expect(() => {
      validateNotLocked(businessId, variantId);
    }).not.toThrow();
  });
});
```

---

## 📚 Documentation Files Created

1. **`F07_IMPLEMENTATION_SUMMARY.md`** - Comprehensive technical implementation guide
2. **`F07_API_QUICK_REFERENCE.md`** - API endpoint reference with cURL examples
3. **`F07_INTEGRATION_GUIDE.md`** - This file, integration checklist and testing guide

---

## 🚀 Deployment Checklist

Before deploying F07 to production:

- [ ] RBAC permissions registered in database/system
- [ ] Lock validation integrated into F04 (POS)
- [ ] Lock validation integrated into F03 (Purchases)
- [ ] Database migrations applied (if any schema changes)
- [ ] Staging environment testing completed
- [ ] Staff training completed on audit workflow
- [ ] UI/Frontend for F07 implemented
- [ ] Monitoring/logging configured for audit operations
- [ ] Backup strategy tested with audit data
- [ ] Rollback procedure documented

---

## 🔍 Monitoring & Debugging

### Key Logs to Monitor

```typescript
// When audit is created
console.log(`Audit created: ${auditCode}, locked ${affectedVariantCount} variants`);

// When count is recorded
console.log(`Count recorded: snapshot=${snapshotQty}, counted=${countedQty}`);

// When discrepancy detected
console.log(`Discrepancy: diff=${diffQty}, reason="${discrepancyReason}"`);

// When audit approved
console.log(`Audit approved by ${approvedBy}`);

// When audit applied
console.log(`Audit applied: ${itemsApplied} items, ${ledgerEntriesCreated} ledger entries`);

// When lock prevents transaction
console.error(`Transaction blocked: variant locked for audit`);
```

### Querying Audit Status

```sql
-- Find all in-progress audits
SELECT * FROM stock_audits WHERE status = 'IN_PROGRESS';

-- Find locked variants
SELECT id, sku FROM product_variants WHERE is_locked_for_audit = true;

-- Find audits affecting a variant
SELECT DISTINCT sa.* FROM stock_audits sa
JOIN stock_audit_items sai ON sa.id = sai.audit_id
WHERE sai.variant_id = $1;

-- Find total adjustments from audit
SELECT SUM(quantity_changed) as total_diff, transaction_type
FROM inventory_ledger
WHERE reference_doc_type = 'STOCK_AUDIT'
GROUP BY transaction_type;
```

---

## 💡 Tips & Best Practices

### For Staff (Counting)
1. Scan items systematically (left to right, top to bottom)
2. If count differs from screen, always note the reason
3. Examples of good reasons:
   - "1 damaged, 1 expired, 1 wrong location"
   - "2 items still in receiving area"
   - "Item not in system"

### For Managers (Approval)
1. Review all discrepancies before approving
2. Look for patterns (repeated locations, product types)
3. Investigate large discrepancies before approving

### For System Developers
1. Always lock variants atomically with audit creation
2. Capture snapshots exactly once per variant/lot
3. Create ledger entries within same transaction as balance updates
4. Log all discrepancies for analytics

---

## ❓ Troubleshooting

### Problem: "Audit code already exists"
- **Cause:** Duplicate audit code in same business
- **Solution:** Use unique code, e.g., append timestamp

### Problem: "Discrepancy reason required"
- **Cause:** Counted ≠ snapshot but no reason provided
- **Solution:** Call PATCH endpoint to update both countedQty and reason

### Problem: "Variant is locked for audit"
- **Cause:** Transaction attempted during audit
- **Solution:** Wait for audit to complete (APPLIED status)

### Problem: Ledger entries not created
- **Cause:** Apply failed, no diff_qty, or transaction rolled back
- **Solution:** Check audit status and diff calculations, retry apply

---

## 📞 Support & Escalation

For issues with F07 implementation:

1. Check error message (should be descriptive)
2. Verify audit status (IN_PROGRESS, PENDING_APPROVAL, APPLIED)
3. Check variant lock status
4. Review audit items for missing discrepancy reasons
5. Check database for related records
6. Consult `F07_IMPLEMENTATION_SUMMARY.md` for technical details

---

## 📊 Success Metrics

Track these metrics after F07 deployment:

- **Audit Creation Rate** - Audits created per week
- **Average Discrepancy Rate** - % of items with diff ≠ 0
- **Audit Completion Time** - Time from IN_PROGRESS to APPLIED
- **Lock Duration** - Average time variants are locked
- **Transaction Blocks** - Times lock prevented transaction
- **Data Accuracy** - Comparison of system vs physical counts
