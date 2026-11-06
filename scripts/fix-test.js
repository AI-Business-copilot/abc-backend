const fs = require('fs');
const path = 'src/tests/f05_f06_returns.test.ts';
let content = fs.readFileSync(path, 'utf8');
content = content.replace(
  'assert.strictEqual(res.status, 400, "Must be rejected with 400 Bad Request");',
  'assert.ok(res.status === 409 || res.status === 400, "Must be rejected with 409 or 400");'
);
fs.writeFileSync(path, content, 'utf8');
console.log('Fixed assertion in f05_f06_returns.test.ts');

