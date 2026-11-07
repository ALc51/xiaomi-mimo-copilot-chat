import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatYmd, keyFingerprint, lastNBillingDays, shiftYmd } from './billingDays';

describe('billingDays', () => {
	it('shiftYmd crosses month boundaries', () => {
		assert.equal(shiftYmd('2026-03-01', -1), '2026-02-28');
		assert.equal(shiftYmd('2026-01-01', 0), '2026-01-01');
	});

	it('formatYmd uses UTC calendar', () => {
		assert.equal(formatYmd(2026, 10, 7), '2026-11-07');
	});

	it('lastNBillingDays extends end to local date ahead of UTC', () => {
		// 2026-11-07 01:00 in UTC+8 → local 11-07, UTC still 11-06
		const now = new Date('2026-11-06T17:00:00.000Z');
		const range = lastNBillingDays(3, now);
		assert.equal(range.end, '2026-11-07');
		assert.deepEqual(range.days, ['2026-11-05', '2026-11-06', '2026-11-07']);
	});

	it('keyFingerprint is stable and distinguishes keys', () => {
		assert.equal(keyFingerprint('sk-aaa'), keyFingerprint('sk-aaa'));
		assert.notEqual(keyFingerprint('sk-aaa'), keyFingerprint('sk-aab'));
	});
});
