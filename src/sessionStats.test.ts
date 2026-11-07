import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { SessionStats } from './sessionStats';
import type { CostEstimate } from './pricing';
import type { ApiUsage } from './usage';

describe('sessionStats', () => {
	let stats: SessionStats;

	beforeEach(() => {
		stats = new SessionStats();
	});

	it('records PAYG turns and accumulates session amount', () => {
		const usage: ApiUsage = {
			prompt_tokens: 1000,
			completion_tokens: 500,
			total_tokens: 1500,
		};
		const cost1: CostEstimate = {
			kind: 'payg',
			currency: 'CNY',
			amount: 0.05,
			label: '¥0.05',
			breakdown: '',
			parts: [],
			priceSource: '',
		};

		stats.recordTurn({
			modelId: 'mimo-v2.6-flash',
			usage,
			tokPerSec: 50,
			ttftMs: 200,
			cost: cost1,
			baseUrl: 'https://api.xiaomimimo.com/v1',
		});

		const snap1 = stats.snapshot();
		assert.equal(snap1.turnCount, 1);
		assert.equal(snap1.sessionAmount, 0.05);
		assert.equal(snap1.sessionCurrency, 'CNY');
		assert.equal(snap1.sessionCostLabel, '¥0.0500');
		assert.equal(snap1.last?.tokPerSec, 50);

		const cost2: CostEstimate = {
			...cost1,
			amount: 0.15,
		};
		stats.recordTurn({
			modelId: 'mimo-v2.6-flash',
			usage,
			tokPerSec: 60,
			ttftMs: 180,
			cost: cost2,
			baseUrl: 'https://api.xiaomimimo.com/v1',
		});

		const snap2 = stats.snapshot();
		assert.equal(snap2.turnCount, 2);
		assert.ok(Math.abs(snap2.sessionAmount - 0.20) < 1e-6);
		assert.equal(snap2.sessionCostLabel, '¥0.2000');
	});

	it('clear resets session stats', () => {
		const usage: ApiUsage = {
			prompt_tokens: 10,
			completion_tokens: 10,
			total_tokens: 20,
		};
		stats.recordTurn({
			modelId: 'mimo-v2.6-flash',
			usage,
			baseUrl: 'https://api.xiaomimimo.com/v1',
		});
		assert.equal(stats.snapshot().turnCount, 1);

		stats.clear();
		const snap = stats.snapshot();
		assert.equal(snap.turnCount, 0);
		assert.equal(snap.sessionAmount, 0);
		assert.equal(snap.sessionCurrency, undefined);
		assert.equal(snap.last, undefined);
	});

	it('notifies listeners on change and supports disposal', () => {
		let fired = 0;
		const sub = stats.onChange(() => {
			fired++;
		});

		const usage: ApiUsage = {
			prompt_tokens: 1,
			completion_tokens: 1,
			total_tokens: 2,
		};
		stats.recordTurn({
			modelId: 'mimo-v2.6-flash',
			usage,
			baseUrl: 'https://api.xiaomimimo.com/v1',
		});
		assert.equal(fired, 1);

		stats.clear();
		assert.equal(fired, 2);

		sub.dispose();
		stats.recordTurn({
			modelId: 'mimo-v2.6-flash',
			usage,
			baseUrl: 'https://api.xiaomimimo.com/v1',
		});
		assert.equal(fired, 2); // Listener unsubscribed
	});
});
