import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	sanitizeForLog,
	truncate,
	summarizeMessages,
	toolNamesFromBody,
} from './debugLog';

describe('debugLog', () => {
	it('truncate cuts strings to limit and indicates extra characters', () => {
		assert.equal(truncate('short', 10), 'short');
		assert.equal(truncate('hello world', 5), 'hello…(+6)');
	});

	it('sanitizeForLog redacts sensitive credentials and passwords', () => {
		const payload = {
			apiKey: 'sk-secret-123',
			authorization: 'Bearer token',
			password: 'my-password',
			safeField: 'normal text',
			nested: {
				token: 'nested-token',
				image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
			},
		};

		const sanitized = sanitizeForLog(payload) as Record<string, unknown>;
		assert.equal(sanitized.apiKey, '[redacted]');
		assert.equal(sanitized.authorization, '[redacted]');
		assert.equal(sanitized.password, '[redacted]');
		assert.equal(sanitized.safeField, 'normal text');

		const nested = sanitized.nested as Record<string, unknown>;
		assert.equal(nested.token, '[redacted]');
		assert.ok(String(nested.image).startsWith('[image data '));
	});

	it('summarizeMessages counts message roles accurately', () => {
		const messages = [
			{ role: 'system' as const, content: 'sys' },
			{ role: 'user' as const, content: 'q1' },
			{ role: 'assistant' as const, content: 'a1' },
			{ role: 'user' as const, content: 'q2' },
		];
		const summary = summarizeMessages(messages);
		assert.ok(summary.includes('system=1'));
		assert.ok(summary.includes('user=2'));
		assert.ok(summary.includes('assistant=1'));
	});

	it('toolNamesFromBody extracts names from function tools or fallback types', () => {
		const tools = [
			{ type: 'function', function: { name: 'get_weather' } },
			{ type: 'web_search' },
		];
		const names = toolNamesFromBody(tools);
		assert.deepEqual(names, ['get_weather', 'web_search']);
	});
});

