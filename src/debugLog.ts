import type { ChatCompletionRequest } from './mimoClient';
import type { ApiUsage } from './usage';

const PREVIEW_CHARS = 240;

/** Redact secrets and truncate long strings for Output Channel logs. */
export function sanitizeForLog(value: unknown, depth = 0): unknown {
	if (depth > 4) {
		return '[…]';
	}
	if (typeof value === 'string') {
		return truncate(value, PREVIEW_CHARS);
	}
	if (Array.isArray(value)) {
		if (value.length > 12) {
			return [...value.slice(0, 12).map((v) => sanitizeForLog(v, depth + 1)), `…(+${value.length - 12})`];
		}
		return value.map((v) => sanitizeForLog(v, depth + 1));
	}
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (/api[_-]?key|authorization|secret|token|password/i.test(k)) {
				out[k] = '[redacted]';
			} else if (typeof v === 'string' && /^data:[^;]+;base64,/i.test(v)) {
				out[k] = `[image data ${v.length} chars]`;
			} else {
				out[k] = sanitizeForLog(v, depth + 1);
			}
		}
		return out;
	}
	return value;
}

export function truncate(s: string, max = PREVIEW_CHARS): string {
	if (s.length <= max) {
		return s;
	}
	return `${s.slice(0, max)}…(+${s.length - max})`;
}

export function summarizeMessages(messages: ChatCompletionRequest['messages']): string {
	const roles = messages.map((m) => m.role);
	const counts = roles.reduce<Record<string, number>>((acc, r) => {
		acc[r] = (acc[r] ?? 0) + 1;
		return acc;
	}, {});
	return Object.entries(counts)
		.map(([role, n]) => `${role}=${n}`)
		.join(' ');
}

export function formatRequestStart(opts: {
	requestId: string;
	baseUrl: string;
	model: string;
	thinking: string;
	toolCount: number;
	toolChoice?: string;
	messageCount: number;
	messageSummary: string;
	maxCompletionTokens: number;
	webSearch: boolean;
}): string {
	return [
		`── request ${opts.requestId} ──`,
		`model=${opts.model}`,
		`baseUrl=${opts.baseUrl}`,
		`thinking=${opts.thinking}`,
		`messages=${opts.messageCount} (${opts.messageSummary})`,
		`tools=${opts.toolCount}${opts.toolChoice ? ` tool_choice=${opts.toolChoice}` : ''}`,
		`max_completion_tokens=${opts.maxCompletionTokens}`,
		`web_search=${opts.webSearch}`,
	].join('\n');
}

const DETAIL_MESSAGE_CAP = 40;
const DETAIL_CONTENT_CHARS = 800;

/** Compact sanitized message array for the Debug panel detail document. */
export function buildMessagesPreview(messages: ChatCompletionRequest['messages']): unknown {
	const sliced = messages.length > DETAIL_MESSAGE_CAP
		? [...messages.slice(0, DETAIL_MESSAGE_CAP), { role: 'system', content: `…(+${messages.length - DETAIL_MESSAGE_CAP} more messages)` }]
		: messages;
	return sanitizeForLog(
		sliced.map((m) => {
			if (typeof m.content === 'string') {
				return { role: m.role, content: truncate(m.content, DETAIL_CONTENT_CHARS) };
			}
			return { ...m, content: sanitizeForLog(m.content) };
		})
	);
}

export function toolNamesFromBody(tools: ChatCompletionRequest['tools']): string[] {
	if (!tools?.length) {
		return [];
	}
	return tools.map((t) => {
		const fn = (t as { function?: { name?: string }; type?: string }).function;
		const type = (t as { type?: string }).type;
		return fn?.name ? fn.name : type ?? 'tool';
	});
}

export function formatRequestBodyPreview(body: ChatCompletionRequest): string {
	const preview = {
		model: body.model,
		thinking: body.thinking,
		temperature: body.temperature,
		top_p: body.top_p,
		tool_choice: body.tool_choice,
		tools: toolNamesFromBody(body.tools),
		messages: sanitizeForLog(body.messages),
	};
	return `body preview:\n${JSON.stringify(preview, null, 2)}`;
}

export function formatRequestEnd(opts: {
	requestId: string;
	ok: boolean;
	durationMs: number;
	ttftMs?: number;
	textChars: number;
	thinkingChars: number;
	toolCalls: Array<{ id: string; name: string }>;
	usage?: ApiUsage;
	error?: string;
}): string {
	const lines = [
		`── ${opts.ok ? 'Done' : 'Failed'} ${opts.requestId} ──`,
		`Duration=${opts.durationMs}ms`,
		opts.ttftMs !== undefined ? `First token=${opts.ttftMs}ms` : 'First token=N/A',
		`Text chars=${opts.textChars}`,
		`Thinking chars=${opts.thinkingChars}`,
		`Tool calls=${opts.toolCalls.length}${opts.toolCalls.length ? ` [${opts.toolCalls.map((c) => c.name).join(', ')}]` : ''}`,
	];
	if (opts.usage) {
		lines.push(
			`Usage Prompt=${opts.usage.prompt_tokens} Completion=${opts.usage.completion_tokens} Total=${opts.usage.total_tokens} Cached=${opts.usage.prompt_tokens_details?.cached_tokens ?? 0}`
		);
	}
	if (opts.error) {
		lines.push(`Error=${opts.error}`);
	}
	return lines.join('\n');
}
