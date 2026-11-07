import * as vscode from 'vscode';

export class MimoApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly body?: string
	) {
		super(message);
		this.name = 'MimoApiError';
	}
}

export function mapHttpError(status: number, bodyText: string): MimoApiError {
	// Keep user-facing messages free of raw server dumps; retain body on the error for Output/debug.
	switch (status) {
		case 400:
			return new MimoApiError(
				status,
				'请求格式无效 (400)。请检查 messages / reasoning_content 回传 / 多模态限制。',
				bodyText
			);
		case 401:
			return new MimoApiError(
				status,
				'认证失败 (401)。请检查 API Key，并确认 Key 与 Base URL 同属按量或 Token Plan，不可混用。',
				bodyText
			);
		case 402:
			return new MimoApiError(status, '余额不足 (402)。请到 MiMo 控制台充值。', bodyText);
		case 403:
			return new MimoApiError(status, '访问被拒绝 (403)。可能是区域限制或风控，请尝试新 Key。', bodyText);
		case 404:
			return new MimoApiError(status, '未找到 (404)。模型或端点可能不支持当前能力（例如图像）。', bodyText);
		case 421:
			return new MimoApiError(status, '内容安全拦截 (421)。请调整输入内容。', bodyText);
		case 429:
			return new MimoApiError(
				status,
				'请求过于频繁或 Token Plan 额度耗尽 (429)。将自动重试或请降低频率。',
				bodyText
			);
		case 500:
			return new MimoApiError(status, '服务端错误 (500)。请稍后重试。', bodyText);
		case 503:
			return new MimoApiError(status, '服务过载 (503)。请稍后重试。', bodyText);
		default:
			return new MimoApiError(status, `MiMo API 错误 HTTP ${status}。`, bodyText);
	}
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new vscode.CancellationError());
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new vscode.CancellationError());
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

export function toUserFacingError(err: unknown): Error {
	if (err instanceof MimoApiError) {
		return new Error(err.message);
	}
	if (err instanceof vscode.CancellationError) {
		return err;
	}
	if (err instanceof Error) {
		if (err.name === 'AbortError') {
			return new Error('请求超时或已取消。可在设置中增大 xiaomiMimo.requestTimeoutMs。');
		}
		return err;
	}
	return new Error(String(err));
}

export async function withRetry<T>(
	fn: () => Promise<T>,
	options: { retries: number; shouldRetry: (err: unknown) => boolean; signal?: AbortSignal }
): Promise<T> {
	let last: unknown;
	for (let attempt = 0; attempt <= options.retries; attempt++) {
		if (options.signal?.aborted) {
			throw new vscode.CancellationError();
		}
		try {
			return await fn();
		} catch (err) {
			last = err;
			if (attempt === options.retries || !options.shouldRetry(err)) {
				throw err;
			}
			const delay = Math.min(8000, 500 * 2 ** attempt);
			await abortableSleep(delay, options.signal);
		}
	}
	throw last;
}

export function isRetryable(err: unknown): boolean {
	return err instanceof MimoApiError && (err.status === 429 || err.status === 500 || err.status === 503);
}
