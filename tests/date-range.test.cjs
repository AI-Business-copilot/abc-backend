require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDate, dateRange, metricDate } = require('../src/shared/dates/date-range');

test('dates accept leap days and reject malformed or impossible calendar dates', () => {
  assert.equal(parseDate('2024-02-29', 'from'), '2024-02-29');
  for (const value of [undefined, null, 20260101, '', '2026-2-01', '2026-02-29', '2026-04-31', '2026-13-01', '2026-01-00', '2026-01-01T00:00:00Z']) {
    assert.throws(() => parseDate(value, 'from'), error => error.statusCode === 400 && error.message.includes('from'));
  }
});
test('report ranges include both endpoints across month and year boundaries', () => {
  assert.deepEqual(dateRange('2026-11-17', '2026-11-17'), { from: '2026-11-17', to: '2026-11-17', dayCount: 1 });
  assert.equal(dateRange('2024-02-28', '2024-03-01').dayCount, 3);
  assert.equal(dateRange('2025-12-31', '2026-01-01').dayCount, 2);
});
test('report ranges enforce order and the inclusive 366 day limit', () => {
  assert.equal(dateRange('2024-01-01', '2024-12-31').dayCount, 366);
  assert.throws(() => dateRange('2024-01-01', '2025-01-01'), error => error.statusCode === 400);
  assert.throws(() => dateRange('2026-11-17', '2026-11-16'), error => error.statusCode === 400);
});
test('metric dates use UTC midnight', () => {
  assert.equal(metricDate('2026-11-17').toISOString(), '2026-11-17T00:00:00.000Z');
});
