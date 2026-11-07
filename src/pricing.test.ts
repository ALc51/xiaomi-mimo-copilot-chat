import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	lookupModelPrices,
	formatMoney,
	formatBalanceAmount,
	estimateTurnCost,
} from './pricing';
import type { ApiUsage } from './usage';

describe('pricing', () => {
	it('lookupModelPrices returns official rates for known models', () => {
		const flashCny = lookupModelPrices('mimo-v2.6-flash', 'CNY');
		assert.ok(flashCny);
		assert.equal(flashCny.currency, 'CNY');
		assert.equal(flashCny.inputPerM, 1);
		assert.equal(flashCny.cacheHitPerM, 0.02);
		assert.equal(flashCny.outputPerM, 2);

		const proUsd = lookupModelPrices('mimo-v2.6-pro', 'USD');
		assert.ok(proUsd);
		assert.equal(proUsd.currency, 'USD');
		assert.equal(proUsd.inputPerM, 0.435);
		assert.equal(proUsd.cacheHitPerM, 0.0036);
		assert.equal(proUsd.outputPerM, 0.87);

		assert.equal(lookupModelPrices('unknown-model', 'CNY'), undefined);
	});

	it('formatMoney formats amounts with currency symbols', () => {
		assert.equal(formatMoney(0, 'CNY'), '¥0');
		assert.equal(formatMoney(0, 'USD'), '$0');
		assert.equal(formatMoney(12.3456, 'CNY'), '¥12.35');
		assert.equal(formatMoney(0.05, 'CNY'), '¥0.0500');
		assert.equal(formatMoney(0.0012, 'USD'), '$0.0012');
		assert.ok(formatMoney(0.00003, 'CNY').startsWith('¥3.00e-5'));
	});

	it('formatBalanceAmount formats raw balance strings', () => {
		assert.equal(formatBalanceAmount('12.34', 'CNY'), '¥12.34');
		assert.equal(formatBalanceAmount('50', 'USD'), '$50.00');
		assert.equal(formatBalanceAmount('invalid', 'CNY'), '¥invalid');
	});

	it('estimateTurnCost calculates PAYG turn cost including cache savings', () => {
		const usage: ApiUsage = {
			prompt_tokens: 1_000_000,
			completion_tokens: 500_000,
			total_tokens: 1_500_000,
			prompt_tokens_details: {
				cached_tokens: 800_000, // 80% cache hit
			},
		};

		const cost = estimateTurnCost({
			model: 'mimo-v2.6-flash',
			usage,
			baseUrl: 'https://api.xiaomimimo.com/v1',
			currencyMode: 'cny',
		});

		assert.equal(cost.kind, 'payg');
		if (cost.kind === 'payg') {
			assert.equal(cost.currency, 'CNY');
			// Uncached: 200k / 1M * 1 = 0.2
			// Cached: 800k / 1M * 0.02 = 0.016
			// Output: 500k / 1M * 2 = 1.0
			// Total: 0.2 + 0.016 + 1.0 = 1.216
			assert.ok(Math.abs(cost.amount - 1.216) < 1e-6);
			assert.equal(cost.parts.length, 3);
			assert.equal(cost.parts[0]?.tokens, 200_000);
			assert.equal(cost.parts[1]?.tokens, 800_000);
			assert.equal(cost.parts[2]?.tokens, 500_000);
		}
	});

	it('estimateTurnCost returns token-plan kind for token-plan baseUrl', () => {
		const usage: ApiUsage = {
			prompt_tokens: 100,
			completion_tokens: 50,
			total_tokens: 150,
		};

		const cost = estimateTurnCost({
			model: 'mimo-v2.6-flash',
			usage,
			baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
		});

		assert.equal(cost.kind, 'token-plan');
		assert.equal(cost.label, 'Token Plan');
	});

	it('estimateTurnCost returns unknown for uncataloged models', () => {
		const usage: ApiUsage = {
			prompt_tokens: 100,
			completion_tokens: 50,
			total_tokens: 150,
		};

		const cost = estimateTurnCost({
			model: 'nonexistent-model',
			usage,
			baseUrl: 'https://api.xiaomimimo.com/v1',
		});

		assert.equal(cost.kind, 'unknown');
	});
});

