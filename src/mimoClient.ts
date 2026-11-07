import * as vscode from 'vscode';
import { mapHttpError, MimoApiError, withRetry, isRetryable } from './errors';
import { ApiUsage } from './usage';
import { OpenAIMessage, cacheReasoning } from './messageConverter';
import { randomUUID } from 'crypto';

export interface ChatCompletionRequest {
	model: string;
	messages: OpenAIMessage[];
	stream: true;
	stream_options: { include_usage: true };
	max_completion_tokens: number;
	temperature?: number;
	top_p?: number;
	tools?: Array<Record<string, unknown>>;
	tool_choice?: string;
	thinking?: { type: 'enabled' | 'disabled' };
	response_format?: unknown;
}

export interface StreamHandlers {
	onText: (text: string) => void;
	onThinking: (text: string, id: string) => void;
	onToolCall: (call: { id: string; name: string; arguments: string }) => void;
	onUsage: (usage: ApiUsage) => void;
	/** Called when SSE choice reports a terminal finish_reason (may fire more than once across tool rounds). */
	onFinishReason?: (reason: string) => void;
	signal: AbortSignal;
}

interface ToolCallAcc {
	id: string;
	name: string;
	arguments: string;
}

export async function streamChatCompletions(
	baseUrl: string,
	apiKey: string,
	body: ChatCompletionRequest,
	timeoutMs: number,
	handlers: StreamHandlers
): Promise<void> {
	const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

	// Retry only HTTP connect failures — never re-run after SSE bytes were consumed (duplicate billing/tools).
	let activeController: AbortController | undefined;
	const onAbort = () => activeController?.abort();
	handlers.signal.addEventListener('abort', onAbort);
	const timer = setTimeout(() => activeController?.abort(), timeoutMs);
	try {
		let streamBody: ReadableStream<Uint8Array> | undefined;
		await withRetry(
			async () => {
				activeController = new AbortController();
				if (handlers.signal.aborted) {
					throw new vscode.CancellationError();
				}
				const res = await fetch(url, {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${apiKey}`,
						'api-key': apiKey,
						'Content-Type': 'application/json',
						Accept: 'text/event-stream',
					},
					body: JSON.stringify(body),
					signal: activeController.signal,
				});
				if (!res.ok) {
					const text = await res.text();
					throw mapHttpError(res.status, text);
				}
				if (!res.body) {
					throw new MimoApiError(0, 'Empty response body from MiMo API');
				}
				streamBody = res.body;
			},
			{
				retries: 2,
				shouldRetry: isRetryable,
				signal: handlers.signal,
			}
		);
		if (!streamBody) {
			throw new MimoApiError(0, 'Empty response body from MiMo API');
		}
		await consumeSse(streamBody, handlers);
	} finally {
		clearTimeout(timer);
		handlers.signal.removeEventListener('abort', onAbort);
	}
}

async function consumeSse(body: ReadableStream<Uint8Array>, handlers: StreamHandlers): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	const toolAcc = new Map<number, ToolCallAcc>();
	let thinkingId = randomUUID();
	let thinkingBuf = '';

	const flushTools = () => {
		const ordered = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]);
		for (const [, call] of ordered) {
			if (call.name) {
				handlers.onToolCall({
					id: call.id || randomUUID(),
					name: call.name,
					arguments: call.arguments || '{}',
				});
			}
		}
		if (thinkingBuf && ordered.length) {
			const key = ordered.map(([, c]) => c.id).join(',');
			cacheReasoning(key, thinkingBuf);
		}
		toolAcc.clear();
	};

	let consecutiveParseFailures = 0;
	const MAX_PARSE_FAILURES = 8;

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split(/\r?\n/);
		buffer = lines.pop() ?? '';

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith(':')) {
				continue;
			}
			if (!trimmed.startsWith('data:')) {
				continue;
			}
			const data = trimmed.slice(5).trim();
			if (data === '[DONE]') {
				flushTools();
				return;
			}
			let json: Record<string, unknown>;
			try {
				json = JSON.parse(data) as Record<string, unknown>;
				consecutiveParseFailures = 0;
			} catch {
				consecutiveParseFailures += 1;
				if (consecutiveParseFailures >= MAX_PARSE_FAILURES) {
					throw new MimoApiError(0, 'SSE 流解析连续失败，已中止以免截断回复。');
				}
				continue;
			}

			if (json.usage && typeof json.usage === 'object') {
				handlers.onUsage(json.usage as ApiUsage);
			}

			const choices = json.choices as Array<Record<string, unknown>> | undefined;
			if (!choices?.length) {
				continue;
			}
			const choice = choices[0]!;
			// Prefer delta (true SSE); fall back to message for providers that emit a single full chunk.
			const delta = (choice.delta ?? choice.message ?? {}) as Record<string, unknown>;
			const finish = choice.finish_reason as string | null | undefined;

			if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
				thinkingBuf += delta.reasoning_content;
				handlers.onThinking(delta.reasoning_content, thinkingId);
			}
			if (typeof delta.content === 'string' && delta.content) {
				handlers.onText(delta.content);
			}

			const tcs = delta.tool_calls as Array<Record<string, unknown>> | undefined;
			if (tcs) {
				for (const tc of tcs) {
					const index = typeof tc.index === 'number' ? tc.index : 0;
					const fn = (tc.function ?? {}) as Record<string, unknown>;
					const prev = toolAcc.get(index) ?? { id: '', name: '', arguments: '' };
					if (typeof tc.id === 'string' && tc.id) {
						prev.id = tc.id;
					}
					if (typeof fn.name === 'string' && fn.name) {
						prev.name = fn.name;
					}
					if (typeof fn.arguments === 'string') {
						prev.arguments += fn.arguments;
					}
					if (!prev.id) {
						prev.id = randomUUID();
					}
					toolAcc.set(index, prev);
				}
			}

			if (typeof finish === 'string' && finish) {
				handlers.onFinishReason?.(finish);
				if (finish === 'tool_calls' || finish === 'stop') {
					if (toolAcc.size) {
						flushTools();
					}
					thinkingId = randomUUID();
				}
			}
		}
	}
	flushTools();
}

export async function listModelsRaw(baseUrl: string, apiKey: string, timeoutMs: number): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'api-key': apiKey,
			},
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timer);
	}
}
