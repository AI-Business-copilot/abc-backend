const assert = require("node:assert/strict");
const { test } = require("node:test");
require("ts-node/register/transpile-only");

const { createPlaceholders } = require("../src/modules/assistant/placeholders");

test("keeps precise values on the backend and restores recognized placeholders", () => {
  const vault = createPlaceholders(["9.007.199.254.740.993 ₫", "20,00%"]);
  assert.deepEqual(vault.tokens, ["X001", "X002"]);
  assert.equal(vault.restore("Doanh thu tăng X001, tương ứng X002."), "Doanh thu tăng 9.007.199.254.740.993 ₫, tương ứng 20,00%.");
  assert.equal(vault.restore("Doanh thu tăng X001."), "Doanh thu tăng 9.007.199.254.740.993 ₫.");
});

test("rejects invented, duplicated, malformed and ungrounded numeric values", () => {
  const vault = createPlaceholders(["100 ₫"]);
  for (const text of ["Tăng X002.", "Tăng X001 và X001.", "Tăng X01.", "Tăng 50 ₫.", "Tăng X001 và ٢ sản phẩm."]) {
    assert.throws(() => vault.restore(text), { statusCode: 502 });
  }
});
