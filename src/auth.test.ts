import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	classifyApiKey,
	classifyBaseUrl,
	resolveBillingPlan,
	planDisplayName,
	checkKeyBaseUrlConsistency,
	PAYG_BASE_URL,
	TOKEN_PLAN_BASE_URL,
} from './auth';

describe('auth', () => {
	it('classifyApiKey classifies keys by prefix', () => {
		assert.equal(classifyApiKey('sk-1234567890abcdef'), 'payg');
		assert.equal(classifyApiKey('tp-abcdef123456'), 'token-plan');
		assert.equal(classifyApiKey('ttp-abcdef123456'), 'token-plan');
		assert.equal(classifyApiKey('unknown-key-format'), 'unknown');
		assert.equal(classifyApiKey('   sk-with-spaces  '), 'payg');
	});

	it('classifyBaseUrl classifies URLs by domain substring', () => {
		assert.equal(classifyBaseUrl(PAYG_BASE_URL), 'payg');
		assert.equal(classifyBaseUrl('https://api.xiaomimimo.com/v1'), 'payg');
		assert.equal(classifyBaseUrl(TOKEN_PLAN_BASE_URL), 'token-plan');
		assert.equal(classifyBaseUrl('https://token-plan-cn.xiaomimimo.com/v1'), 'token-plan');
		assert.equal(classifyBaseUrl('https://custom-proxy.internal/v1'), 'unknown');
	});

	it('resolveBillingPlan prioritizes API Key over Base URL', () => {
		// Matching pairs
		assert.equal(resolveBillingPlan({ apiKey: 'sk-123', baseUrl: PAYG_BASE_URL }), 'payg');
		assert.equal(resolveBillingPlan({ apiKey: 'tp-123', baseUrl: TOKEN_PLAN_BASE_URL }), 'token-plan');

		// Key takes precedence over mismatched URL
		assert.equal(resolveBillingPlan({ apiKey: 'sk-123', baseUrl: TOKEN_PLAN_BASE_URL }), 'payg');
		assert.equal(resolveBillingPlan({ apiKey: 'tp-123', baseUrl: PAYG_BASE_URL }), 'token-plan');

		// Fallback to URL when key prefix is unknown
		assert.equal(resolveBillingPlan({ apiKey: 'unknown', baseUrl: TOKEN_PLAN_BASE_URL }), 'token-plan');
		assert.equal(resolveBillingPlan({ baseUrl: PAYG_BASE_URL }), 'payg');

		// Unknown when neither can be identified
		assert.equal(resolveBillingPlan({ apiKey: 'custom', baseUrl: 'https://proxy/v1' }), 'unknown');
	});

	it('planDisplayName returns readable names', () => {
		assert.equal(planDisplayName('payg'), '按量计费');
		assert.equal(planDisplayName('token-plan'), 'Token Plan');
		assert.equal(planDisplayName('unknown'), '未识别');
	});

	it('checkKeyBaseUrlConsistency detects mismatches', () => {
		assert.equal(checkKeyBaseUrlConsistency('sk-123', PAYG_BASE_URL), undefined);
		assert.equal(checkKeyBaseUrlConsistency('tp-123', TOKEN_PLAN_BASE_URL), undefined);

		const warnPaygKeyOnTokenUrl = checkKeyBaseUrlConsistency('sk-123', TOKEN_PLAN_BASE_URL);
		assert.ok(warnPaygKeyOnTokenUrl && warnPaygKeyOnTokenUrl.includes('不可混用'));

		const warnTokenKeyOnPaygUrl = checkKeyBaseUrlConsistency('tp-123', PAYG_BASE_URL);
		assert.ok(warnTokenKeyOnPaygUrl && warnTokenKeyOnPaygUrl.includes('不可混用'));

		// Unknown should not produce false positive warnings
		assert.equal(checkKeyBaseUrlConsistency('custom-key', PAYG_BASE_URL), undefined);
	});
});

