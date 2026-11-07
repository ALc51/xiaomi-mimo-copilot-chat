import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	cacheHitRate,
	formatCacheHitPercent,
	formatTtft,
	formatUsageLog,
	type ApiUsage,
} from './usage';

describe('usage', () => {
	it('cacheHitRate computes prompt cache hit proportion', () => {
		const usageWithCache: ApiUsage = {
			prompt_tokens: 1000,
			completion_tokens: 200,
			total_tokens: 1200,
			prompt_tokens_details: { cached_tokens: 750 },
		};
		assert.equal(cacheHitRate(usageWithCache), 0.75);

		const usageWithoutCacheDetails: ApiUsage = {
			prompt_tokens: 1000,
			completion_tokens: 200,
			total_tokens: 1200,
		};
		assert.equal(cacheHitRate(usageWithoutCacheDetails), undefined);

		const zeroPrompt: ApiUsage = {
			prompt_tokens: 0,
			completion_tokens: 50,
			total_tokens: 50,
			prompt_tokens_details: { cached_tokens: 0 },
		};
		assert.equal(cacheHitRate(zeroPrompt), undefined);
	});

	it('formatCacheHitPercent formats percentage with two decimals', () => {
		const usage: ApiUsage = {
			prompt_tokens: 300,
			completion_tokens: 100,
			total_tokens: 400,
			prompt_tokens_details: { cached_tokens: 100 },
		};
		assert.equal(formatCacheHitPercent(usage), '33.33%');
	});

	it('formatTtft formats time to first token in ms or seconds', () => {
		assert.equal(formatTtft(undefined), undefined);
		assert.equal(formatTtft(350), '350ms');
		assert.equal(formatTtft(1250), '1.25s');
		assert.equal(formatTtft(2000), '2.00s');
	});

	it('formatUsageLog generates structured summary log', () => {
		const usage: ApiUsage = {
			prompt_tokens: 100,
			completion_tokens: 50,
			total_tokens: 150,
			prompt_tokens_details: { cached_tokens: 40 },
			completion_tokens_details: { reasoning_tokens: 20 },
		};
		const log = formatUsageLog(usage, 45.2, 300, '¥0.01');
		assert.ok(log.includes('Prompt=100'));
		assert.ok(log.includes('Completion=50'));
		assert.ok(log.includes('Total=150'));
		assert.ok(log.includes('Reasoning=20'));
		assert.ok(log.includes('Cached=40'));
		assert.ok(log.includes('Cache=40.00%'));
		assert.ok(log.includes('Tokens/s=45.2'));
		assert.ok(log.includes('First token=300ms'));
		assert.ok(log.includes('Cost=¥0.01'));
	});
});

