import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../js/tz.js';

test('Manila wall time converts to UTC (no DST)', () => {
  assert.equal(new Date(T.zonedToUtc('2026-11-09', '09:00', 'Asia/Manila')).toISOString(), '2026-11-09T01:00:00.000Z');
});

test('London DST handled by IANA data, not hardcoded offsets', () => {
  assert.equal(new Date(T.zonedToUtc('2026-07-01', '09:00', 'Europe/London')).toISOString(), '2026-07-01T08:00:00.000Z');
  assert.equal(new Date(T.zonedToUtc('2026-12-01', '09:00', 'Europe/London')).toISOString(), '2026-12-01T09:00:00.000Z');
  assert.equal(T.offsetMinutes(Date.parse('2026-07-01T12:00:00Z'), 'Europe/London'), 60);
  assert.equal(T.offsetMinutes(Date.parse('2026-12-01T12:00:00Z'), 'Europe/London'), 0);
  assert.equal(T.tzAbbr(Date.parse('2026-07-01T12:00:00Z'), 'Europe/London'), 'BST');
  assert.equal(T.tzAbbr(Date.parse('2026-12-01T12:00:00Z'), 'Europe/London'), 'GMT');
});

test('dates can differ between zones for the same instant', () => {
  const ms = Date.parse('2026-11-09T20:00:00Z');
  assert.equal(T.dateIn(ms, 'Asia/Manila'), '2026-11-10');
  assert.equal(T.dateIn(ms, 'Europe/London'), '2026-11-09');
  assert.equal(T.timeIn(ms, 'Asia/Manila'), '04:00');
});
