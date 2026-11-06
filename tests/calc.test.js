// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../js/calc.js';

test('decimal parsing has no float drift', () => {
  assert.equal(C.toMinor('25.00'), 2500);
  assert.equal(C.toMinor('25'), 2500);
  assert.equal(C.toMinor('0.1'), 10);
  assert.equal(C.toMinor('1,234.56'), 123456);
  assert.equal(C.toMinor('0.125'), 13);
  assert.equal(C.toMinor('-3.5'), -350);
  assert.equal(C.toCenti(4.5), 450);
  assert.equal(C.toCenti(0.1 + 0.2), 30);
  assert.ok(Number.isNaN(C.toMinor('abc')));
});

test('hours formatting', () => {
  assert.equal(C.fmtCenti(150), '1.50 h');
  assert.equal(C.fmtMinutesDec(90), '1.50 h');
  assert.equal(C.fmtHM(90), '1h 30m');
  assert.equal(C.fmtHM(45), '45m');
  assert.equal(C.fmtDate('2026-11-09'), '09 Nov 2026');
  assert.equal(C.fmtSeconds(3725), '01:02:05');
});

const rates = [
  { id: 'r1', contract_id: 'c1', hourly_rate: '25.00', currency: 'XAA', effective_from: '2026-11-09', effective_to: '2027-01-31' },
  { id: 'r2', contract_id: 'c1', hourly_rate: '30.00', currency: 'XAA', effective_from: '2027-02-01', effective_to: null },
  { id: 'r3', contract_id: 'c2', hourly_rate: '40.00', currency: 'XBB', effective_from: '2026-01-01', effective_to: null },
];

test('spec example: salary from approved hours only', () => {
  const approvals = [
    { contract_id: 'c1', period_start: '2026-11-09', period_end: '2026-11-09', approved_hours: '6.0' },
    { contract_id: 'c1', period_start: '2026-11-10', period_end: '2026-11-10', approved_hours: '4.5' },
  ];
  const e = approvals.map(a => C.approvalEarning(a, null, rates));
  assert.deepEqual(e.map(x => x.minor), [15000, 11250]);
  assert.equal(e.reduce((a, x) => a + x.minor, 0), 26250);
  const logged = 720, approvedCenti = e.reduce((a, x) => a + x.centi, 0);
  assert.equal(approvedCenti, 1050);
  assert.equal(C.minutesToCenti(logged) - approvedCenti, 150); // 1.5 h logged-not-approved
});

test('rates are effective-dated', () => {
  assert.equal(C.rateOn(rates, 'c1', '2026-11-08'), null);
  assert.equal(C.rateOn(rates, 'c1', '2027-01-31').id, 'r1');
  assert.equal(C.rateOn(rates, 'c1', '2027-02-01').id, 'r2');
  const a = C.approvalEarning({ contract_id: 'c1', period_start: '2027-01-25', period_end: '2027-02-07', approved_hours: 10 }, null, rates);
  assert.equal(a.minor, 25000);
  assert.equal(a.rateChange, true);
  const missing = C.approvalEarning({ contract_id: 'c1', period_start: '2026-01-01', period_end: '2026-01-01', approved_hours: 2 }, { currency: 'XAA' }, rates);
  assert.equal(missing.rateMissing, true);
  assert.equal(missing.minor, 0);
});

test('multi-currency totals are never summed together', () => {
  const b = {};
  C.addTo(b, 'XAA', 1000); C.addTo(b, 'XBB', 500); C.addTo(b, 'XAA', 250);
  assert.deepEqual(b, { XAA: 1250, XBB: 500 });
  assert.deepEqual(C.mergeBuckets({ XAA: 1 }, { XBB: 2 }, { XAA: 3 }), { XAA: 4, XBB: 2 });
});

test('pending difference flags approved > submitted instead of clamping', () => {
  assert.deepEqual(C.pendingDifference(600, 450), { diff: 150, approvedExceedsSubmitted: false });
  assert.deepEqual(C.pendingDifference(400, 450), { diff: -50, approvedExceedsSubmitted: true });
});

test('availability across employers', () => {
  assert.deepEqual(C.availability(360, 300), { remaining: 60, over: false, overBy: 0 });
  assert.deepEqual(C.availability(360, 420), { remaining: 0, over: true, overBy: 60 });
});

test('overlap detection', () => {
  const entries = [
    { id: 'a', start_at_utc: '2026-11-09T01:00:00Z', end_at_utc: '2026-11-09T03:00:00Z' },
    { id: 'b', start_at_utc: '2026-11-09T05:00:00Z', end_at_utc: '2026-11-09T06:00:00Z' },
  ];
  assert.deepEqual(C.findOverlaps(entries, { id: 'n', start_at_utc: '2026-11-09T02:30:00Z', end_at_utc: '2026-11-09T04:00:00Z' }).map(e => e.id), ['a']);
  assert.equal(C.findOverlaps(entries, { id: 'n', start_at_utc: '2026-11-09T03:00:00Z', end_at_utc: '2026-11-09T05:00:00Z' }).length, 0);
  assert.equal(C.findOverlaps(entries, entries[0]).length, 0);
  assert.equal(C.durationMinutes('2026-11-09T23:30:00Z', '2026-11-10T01:00:00Z'), 90);
});

test('14-day periods from a user anchor', () => {
  assert.deepEqual(C.periodFor('2026-11-09', '2026-11-09'), { number: 1, from: '2026-11-09', to: '2026-11-22' });
  assert.deepEqual(C.periodFor('2026-11-09', '2026-11-23'), { number: 2, from: '2026-11-23', to: '2026-12-06' });
  assert.equal(C.periodFor('2026-11-09', '2026-11-08').number, 0);
  assert.equal(C.periodsBetween('2026-11-09', '2026-11-09', '2027-05-31').length, 15);
  assert.deepEqual(C.fourteenthRange('2026-11-20'), { from: '2026-11-14', to: '2026-12-13' });
  assert.deepEqual(C.fourteenthRange('2027-01-05'), { from: '2026-12-14', to: '2027-01-13' });
  assert.deepEqual(C.weekRange('2026-11-11'), { from: '2026-11-09', to: '2026-11-15' });
  assert.deepEqual(C.monthRange('2027-02-10'), { from: '2027-02-01', to: '2027-02-28' });
});

test('working-day due dates skip weekends', () => {
  assert.equal(C.addWorkingDays('2026-11-09', 14), '2026-11-27'); // Mon + 14 working days
  assert.equal(C.addWorkingDays('2026-11-13', 1), '2026-11-16'); // Fri → Mon
});

test('invoices: allocations prevent double-invoicing; credited invoices release hours', () => {
  const inv = new Map([['i1', { id: 'i1', status: 'Sent' }], ['i2', { id: 'i2', status: 'Credited' }]]);
  const alloc = [
    { invoice_id: 'i1', approval_record_id: 'a1', hours_allocated: '4.00' },
    { invoice_id: 'i2', approval_record_id: 'a1', hours_allocated: '2.00' },
  ];
  assert.equal(C.allocatedByApproval(alloc, inv).get('a1'), 400);
});

test('invoice outstanding and status with partial payments', () => {
  const inv = { id: 'i1', status: 'Sent', subtotal_minor: 26250, adjustments_minor: -250, due_date: '2026-12-01' };
  const pays = [{ invoice_id: 'i1', amount_minor: 10000 }, { invoice_id: 'x', amount_minor: 99 }];
  assert.equal(C.invoiceTotal(inv), 26000);
  assert.equal(C.invoiceOutstanding(inv, pays), 16000);
  assert.equal(C.invoiceStatus(inv, pays, '2026-11-20'), 'Partially paid');
  assert.equal(C.invoiceStatus(inv, pays, '2026-12-02'), 'Overdue');
  assert.equal(C.invoiceStatus(inv, [...pays, { invoice_id: 'i1', amount_minor: 16000 }], '2026-12-02'), 'Paid');
});

test('FX conversion is an estimate and never invents a rate', () => {
  assert.equal(C.convertMinor(26250, 74.123), 1945729);
  assert.equal(C.convertMinor(26250, null), null);
});

test('calculator evaluator', () => {
  assert.equal(C.evaluate('2+3×4'), 14);
  assert.equal(C.evaluate('(2+3)×4'), 20);
  assert.equal(C.evaluate('10÷4'), 2.5);
  assert.equal(C.evaluate('-3+5'), 2);
  assert.equal(C.evaluate('0.1+0.2'), 0.3);
  assert.throws(() => C.evaluate('1÷0'));
  assert.throws(() => C.evaluate('2+'));
});
