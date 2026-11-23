const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = join(__dirname, '..');
const mode = process.argv[2] || 'local';
if (!['unit', 'contracts', 'local'].includes(mode)) throw new Error(`Unknown test group: ${mode}`);
const contract = name => name.includes('swagger');
const files = readdirSync(join(root, 'tests')).filter(name => {
  if (!name.endsWith('.test.cjs') || name.includes('.postgres')) return false;
  return mode === 'local' || (mode === 'contracts' ? contract(name) : !contract(name));
}).sort().map(name => join('tests', name));
if (mode !== 'contracts') files.push('src/tests/business-role-policy.test.ts');
const result = spawnSync(process.execPath, ['--require', 'ts-node/register/transpile-only', '--test', ...files], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
