import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isAssignableBusinessPermission,
  RESERVED_BUSINESS_ROLE_PERMISSION_CODES,
} from "../modules/businesses/business-role-policy";

describe("business role permission policy", () => {
  it("allows business-scoped operational permissions", () => {
    assert.equal(isAssignableBusinessPermission({ code: "inventory.read", scope: "BUSINESS" }), true);
    assert.equal(isAssignableBusinessPermission({ code: "vendor_returns.create", scope: "BUSINESS" }), true);
    assert.equal(isAssignableBusinessPermission({ code: "promotions.manage", scope: "BUSINESS" }), true);
    assert.equal(isAssignableBusinessPermission({ code: "business_data.manage", scope: "BUSINESS" }), true);
  });

  it("blocks platform and business administration permissions", () => {
    assert.equal(isAssignableBusinessPermission({ code: "platform.users.manage", scope: "PLATFORM" }), false);
    for (const code of RESERVED_BUSINESS_ROLE_PERMISSION_CODES) {
      assert.equal(isAssignableBusinessPermission({ code, scope: "BUSINESS" }), false);
    }
  });
});
