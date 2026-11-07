import * as vscode from 'vscode';
import { randomUUID } from 'crypto';

const MAX_IMAGE_BASE64_CHARS = 50 * 1024 * 1024;

export interface OpenAIToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

export interface OpenAIMessage {
	role: 'system' | 'user' | 'assistant' | 'tool' | 'developer';
	content?: string | Array<Record<string, unknown>> | null;
	name?: string;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
	reasoning_content?: string;
}

/** Session cache: assistant tool-call rounds → reasoning text (upstream may drop ThinkingPart). */
const REASONING_CACHE_MAX = 200;
const reasoningCache = new Map<string, string>();

export function cacheReasoning(key: string, text: string): void {
	if (!text) {
		return;
	}
	if (reasoningCache.has(key)) {
		reasoningCache.delete(key);
	}
	reasoningCache.set(key, text);
	while (reasoningCache.size > REASONING_CACHE_MAX) {
		const oldest = reasoningCache.keys().next().value;
		if (oldest === undefined) {
			break;
		}
		reasoningCache.delete(oldest);
	}
}

export function clearReasoningCache(): void {
	reasoningCache.clear();
}

function asRecord(part: unknown): Record<string, unknown> | undefined {
	return part && typeof part === 'object' ? (part as Record<string, unknown>) : undefined;
}

function textValue(part: unknown): string | undefined {
	if (part instanceof vscode.LanguageModelTextPart) {
		return part.value;
	}
	const r = asRecord(part);
	if (r && typeof r.value === 'string' && !('callId' in r) && !('mimeType' in r)) {
		return r.value;
	}
	return undefined;
}

function thinkingValue(part: unknown): string | undefined {
	const r = asRecord(part);
	if (!r) {
		return undefined;
	}
	// LanguageModelThinkingPart (proposed/stable depending on VS Code build)
	if ('value' in r && (typeof r.id === 'string' || r.metadata !== undefined) && !(part instanceof vscode.LanguageModelTextPart)) {
		const ctorName = (part as { constructor?: { name?: string } }).constructor?.name;
		if (ctorName === 'LanguageModelThinkingPart' || ('metadata' in r && !('mimeType' in r) && !('callId' in r))) {
			const v = r.value;
			if (typeof v === 'string') {
				return v;
			}
			if (Array.isArray(v)) {
				return v.map(String).join('');
			}
		}
	}
	return undefined;
}

function toolResultToText(part: vscode.LanguageModelToolResultPart): string {
	const chunks: string[] = [];
	for (const c of part.content) {
		const t = textValue(c);
		if (t !== undefined) {
			chunks.push(t);
		} else if (typeof c === 'string') {
			chunks.push(c);
		} else {
			try {
				chunks.push(JSON.stringify(c));
			} catch {
				/* ignore */
			}
		}
	}
	return chunks.join('');
}

function imageDataUrl(part: vscode.LanguageModelDataPart): string | undefined {
	const mime = part.mimeType || '';
	if (!mime.startsWith('image/')) {
		return undefined;
	}
	const allowed = /^image\/(jpeg|jpg|png|gif|webp|bmp)$/i;
	if (!allowed.test(mime)) {
		throw new Error(`不支持的图片格式: ${mime}。支持 JPEG/PNG/GIF/WebP/BMP。`);
	}
	const b64 = Buffer.from(part.data).toString('base64');
	if (b64.length > MAX_IMAGE_BASE64_CHARS) {
		throw new Error(`图片 Base64 超过 50MB 限制（mime=${mime}）。`);
	}
	return `data:${mime};base64,${b64}`;
}

function roleOf(msg: vscode.LanguageModelChatRequestMessage): OpenAIMessage['role'] {
	const role = msg.role as number;
	// Stable enum: User=1, Assistant=2. Some hosts may still send System=0.
	if (role === vscode.LanguageModelChatMessageRole.Assistant) {
		return 'assistant';
	}
	if (role === 0) {
		return 'system';
	}
	return 'user';
}

export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[]
): OpenAIMessage[] {
	const out: OpenAIMessage[] = [];

	for (const msg of messages) {
		const toolCalls: OpenAIToolCall[] = [];
		const toolResults: Array<{ id: string; text: string }> = [];
		const thinkingBits: string[] = [];
		const contentParts: Array<Record<string, unknown>> = [];
		let textJoined = '';

		for (const part of msg.content) {
			const think = thinkingValue(part);
			if (think !== undefined) {
				if (think) {
					thinkingBits.push(think);
				}
				continue;
			}
			if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({
					id: part.callId || randomUUID(),
					type: 'function',
					function: {
						name: part.name,
						arguments: JSON.stringify(part.input ?? {}),
					},
				});
				continue;
			}
			if (part instanceof vscode.LanguageModelToolResultPart) {
				toolResults.push({
					id: part.callId || randomUUID(),
					text: toolResultToText(part),
				});
				continue;
			}
			if (part instanceof vscode.LanguageModelDataPart) {
				const url = imageDataUrl(part);
				if (url) {
					contentParts.push({ type: 'image_url', image_url: { url } });
				} else {
					const mime = part.mimeType || 'application/octet-stream';
					const note = `[不支持的附件类型: ${mime}]`;
					textJoined += note;
					contentParts.push({ type: 'text', text: note });
				}
				continue;
			}
			const tv = textValue(part);
			if (tv !== undefined) {
				textJoined += tv;
				contentParts.push({ type: 'text', text: tv });
			}
		}

		// One OpenAI tool message per ToolResultPart (parallel tools must not collapse).
		if (toolResults.length > 0) {
			for (const tr of toolResults) {
				out.push({
					role: 'tool',
					tool_call_id: tr.id,
					content: tr.text,
				});
			}
			continue;
		}

		const role = roleOf(msg);
		const openaiMsg: OpenAIMessage = { role };

		if (toolCalls.length > 0) {
			openaiMsg.tool_calls = toolCalls;
			openaiMsg.content = textJoined || null;
		} else if (contentParts.some((p) => p.type === 'image_url')) {
			openaiMsg.content = contentParts.length ? contentParts : textJoined;
		} else {
			openaiMsg.content = textJoined;
		}

		let reasoning = thinkingBits.join('');
		if (!reasoning && toolCalls.length > 0) {
			const cacheKey = toolCalls.map((t) => t.id).join(',');
			reasoning = reasoningCache.get(cacheKey) ?? '';
		}
		if (reasoning) {
			openaiMsg.reasoning_content = reasoning;
			if (toolCalls.length > 0) {
				cacheReasoning(toolCalls.map((t) => t.id).join(','), reasoning);
			}
		}

		out.push(openaiMsg);
	}

	return out;
}

export function convertTools(
	tools: readonly vscode.LanguageModelChatTool[] | undefined
): Array<Record<string, unknown>> | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}
	return tools.map((tool) => ({
		type: 'function',
		function: {
			name: tool.name,
			description: tool.description ?? '',
			parameters: tool.inputSchema ?? { type: 'object', properties: {} },
		},
	}));
}

export function mapToolChoice(
	_toolMode: vscode.LanguageModelChatToolMode | undefined,
	hasTools: boolean
): string | undefined {
	if (!hasTools) {
		return undefined;
	}
	// MiMo OpenAI API only accepts tool_choice=auto; other values are stripped server-side.
	return 'auto';
}
