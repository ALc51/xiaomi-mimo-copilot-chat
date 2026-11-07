import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatResetHint, isPaygBalanceExhausted, type PaygBalance } from './platformApi';

describe('platformApi', () => {
	it('formatResetHint converts UTC timestamp to Beijing time (UTC+8)', () => {
		assert.equal(formatResetHint(''), '重置时间未知');

		// 2026-11-01 00:00:00 UTC -> 2026-11-01 08:00:00 Beijing
		assert.equal(formatResetHint('2026-11-01T00:00:00Z'), '在 08:00 重置 11月1日');

		// 2026-11-01 16:30:00 UTC -> 2026-11-02 00:30:00 Beijing (crosses day boundary)
		assert.equal(formatResetHint('2026-11-01 16:30:00'), '在 00:30 重置 11月2日');
	});

	it('isPaygBalanceExhausted checks both isAvailable flag and totalAvailable amount', () => {
		const positiveBalance: PaygBalance = {
			currency: 'CNY',
			cashBalance: '10.00',
			giftBalance: '5.00',
			frozenBalance: '0.00',
			totalAvailable: '15.00',
			isAvailable: true,
		};
		assert.equal(isPaygBalanceExhausted(positiveBalance), false);

		const zeroBalance: PaygBalance = {
			...positiveBalance,
			totalAvailable: '0.00',
		};
		assert.equal(isPaygBalanceExhausted(zeroBalance), true);

		const negativeBalance: PaygBalance = {
			...positiveBalance,
			totalAvailable: '-1.50',
		};
		assert.equal(isPaygBalanceExhausted(negativeBalance), true);

		const unavailableBalance: PaygBalance = {
			...positiveBalance,
			isAvailable: false,
		};
		assert.equal(isPaygBalanceExhausted(unavailableBalance), true);
	});
});

