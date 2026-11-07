import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	mapHttpError,
	MimoApiError,
	isRetryable,
	toUserFacingError,
	withRetry,
} from './errors';

describe('errors', () => {
	it('mapHttpError produces user-friendly error messages for known statuses', () => {
		const err401 = mapHttpError(401, 'Unauthorized');
		assert.ok(err401 instanceof MimoApiError);
		assert.equal(err401.status, 401);
		assert.ok(err401.message.includes('401'));
		assert.equal(err401.body, 'Unauthorized');

		const err402 = mapHttpError(402, 'Payment Required');
		assert.ok(err402.message.includes('余额不足'));

		const err429 = mapHttpError(429, 'Rate Limited');
		assert.ok(err429.message.includes('429'));

		const err500 = mapHttpError(500, 'Internal Server Error');
		assert.ok(err500.message.includes('500'));
	});

	it('isRetryable only retries 429, 500, and 503', () => {
		assert.equal(isRetryable(new MimoApiError(429, 'too many')), true);
		assert.equal(isRetryable(new MimoApiError(500, 'server err')), true);
		assert.equal(isRetryable(new MimoApiError(503, 'service unavailable')), true);
		assert.equal(isRetryable(new MimoApiError(401, 'unauthorized')), false);
		assert.equal(isRetryable(new MimoApiError(400, 'bad request')), false);
		assert.equal(isRetryable(new Error('general error')), false);
	});

	it('toUserFacingError strips raw technical details from MimoApiError', () => {
		const apiErr = new MimoApiError(401, '认证失败 (401)', '{"raw":"server body"}');
		const userErr = toUserFacingError(apiErr);
		assert.equal(userErr.message, '认证失败 (401)');
	});

	it('withRetry retries until success or max attempts', async () => {
		let attempts = 0;
		const res = await withRetry(
			async () => {
				attempts++;
				if (attempts < 2) {
					throw new MimoApiError(500, 'Temporary 500');
				}
				return 'ok';
			},
			{
				retries: 2,
				shouldRetry: isRetryable,
			}
		);
		assert.equal(res, 'ok');
		assert.equal(attempts, 2);
	});

	it('withRetry throws on non-retryable error without retrying', async () => {
		let attempts = 0;
		await assert.rejects(
			async () => {
				await withRetry(
					async () => {
						attempts++;
						throw new MimoApiError(401, 'Unauthorized');
					},
					{
						retries: 2,
						shouldRetry: isRetryable,
					}
				);
			},
			(err: unknown) => err instanceof MimoApiError && err.status === 401
		);
		assert.equal(attempts, 1);
	});
});

