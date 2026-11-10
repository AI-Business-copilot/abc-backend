const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yamljs");

const spec = YAML.load(path.join(__dirname, "../src/swagger/f07-f08-openapi.yaml"));
const routesSource = fs.readFileSync(
  path.join(__dirname, "../src/modules/inventory/inventory.routes.ts"),
  "utf8",
);

/** Express uses `:id`, OpenAPI uses `{id}`; the comparison needs one spelling. */
const normalize = (routePath) => routePath.replace(/:([A-Za-z]+)/g, "{$1}");

/** Only the F07 audit and F08 lot/scrap routes belong to this spec. */
const isF07F08 = (routePath) =>
  routePath.startsWith("/audits") ||
  routePath === "/lots/expiring" ||
  /^\/lots\/\{[^}]+\}$/.test(routePath) ||
  routePath.endsWith("/quarantine") ||
  routePath.startsWith("/scrap-orders") ||
  routePath === "/scrap-statistics" ||
  routePath.startsWith("/scrap-order-images");

test("the F07 and F08 spec documents exactly the implemented inventory routes", () => {
  const methods = ["get", "post", "patch", "put", "delete"];

  const documented = Object.entries(spec.paths)
    .filter(([routePath]) => routePath.startsWith("/inventory/"))
    .filter(([routePath]) => isF07F08(routePath.slice("/inventory".length)))
    .flatMap(([routePath, operations]) =>
      methods.filter((method) => operations[method]).map((method) => `${method} ${routePath}`),
    )
    .sort();

  // Some handlers put the path on the next line, so whitespace is allowed after the opening bracket.
  const implemented = [...routesSource.matchAll(/router\.(get|post|patch|put|delete)\(\s*"([^"]+)"/g)]
    .map(([, method, routePath]) => `${method} /inventory${normalize(routePath)}`)
    .filter((entry) => isF07F08(entry.slice(entry.indexOf(" ") + 1).slice("/inventory".length)))
    .sort();

  assert.ok(implemented.length > 0, "no F07/F08 route was found in inventory.routes.ts");
  assert.deepEqual(
    documented,
    implemented,
    "f07-f08-openapi.yaml and inventory.routes.ts must list the same F07/F08 endpoints",
  );
});

test("every reference in the spec points at a declared schema", () => {
  for (const [, name] of JSON.stringify(spec).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)) {
    assert.ok(spec.components.schemas[name], `Missing schema ${name}`);
  }
  for (const [name, schema] of Object.entries(spec.components.schemas)) {
    assert.ok(schema.type || schema.oneOf || schema.allOf || schema.$ref, `Schema ${name} has no type`);
  }
});
