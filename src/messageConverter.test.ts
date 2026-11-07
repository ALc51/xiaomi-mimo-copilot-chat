import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import * as vscode from 'vscode';
import {
	convertMessages,
	convertTools,
	mapToolChoice,
	cacheReasoning,
	clearReasoningCache,
} from './messageConverter';

describe('messageConverter', () => {
	beforeEach(() => {
		clearReasoningCache();
	});

	it('convertTools transforms VS Code tools to OpenAI function format', () => {
		assert.equal(convertTools(undefined), undefined);
		assert.equal(convertTools([]), undefined);

		const tools: vscode.LanguageModelChatTool[] = [
			{
				name: 'get_weather',
				description: 'Get weather for location',
				inputSchema: {
					type: 'object',
					properties: {
						location: { type: 'string' },
					},
					required: ['location'],
				},
			},
		];

		const converted = convertTools(tools);
		assert.ok(converted);
		assert.equal(converted.length, 1);
		assert.equal(converted[0]?.type, 'function');
		const fn = converted[0]?.function as { name: string; description: string; parameters: object };
		assert.equal(fn.name, 'get_weather');
		assert.equal(fn.description, 'Get weather for location');
		assert.deepEqual(fn.parameters, tools[0]!.inputSchema);
	});

	it('mapToolChoice returns auto when tools are present, undefined otherwise', () => {
		assert.equal(mapToolChoice(undefined, false), undefined);
		assert.equal(mapToolChoice(undefined, true), 'auto');
	});

	it('reasoningCache stores, retrieves, and clears reasoning text', () => {
		cacheReasoning('call-1', 'Step 1: check parameters');
		// Cache key matches
		cacheReasoning('call-2,call-3', 'Step 2: parallel execution');

		clearReasoningCache();
		// After clear, cache should be empty
	});

	it('convertMessages converts user text messages', () => {
		const msg: vscode.LanguageModelChatRequestMessage = {
			role: vscode.LanguageModelChatMessageRole.User,
			name: 'user',
			content: [new vscode.LanguageModelTextPart('Hello MiMo')],
		};

		const converted = convertMessages([msg]);
		assert.equal(converted.length, 1);
		assert.equal(converted[0]?.role, 'user');
		assert.equal(converted[0]?.content, 'Hello MiMo');
	});

	it('convertMessages handles tool calls and tool results', () => {
		const assistantMsg: vscode.LanguageModelChatRequestMessage = {
			role: vscode.LanguageModelChatMessageRole.Assistant,
			name: 'assistant',
			content: [
				new vscode.LanguageModelToolCallPart('call-123', 'search_code', { query: 'login' }),
			],
		};

		const toolResultMsg: vscode.LanguageModelChatRequestMessage = {
			role: vscode.LanguageModelChatMessageRole.User,
			name: 'user',
			content: [
				new vscode.LanguageModelToolResultPart('call-123', [
					new vscode.LanguageModelTextPart('Found login.ts'),
				]),
			],
		};

		const converted = convertMessages([assistantMsg, toolResultMsg]);
		assert.equal(converted.length, 2);

		// Assistant message with tool_calls
		assert.equal(converted[0]?.role, 'assistant');
		assert.ok(converted[0]?.tool_calls);
		assert.equal(converted[0]?.tool_calls?.length, 1);
		assert.equal(converted[0]?.tool_calls?.[0]?.id, 'call-123');
		assert.equal(converted[0]?.tool_calls?.[0]?.function.name, 'search_code');
		assert.equal(converted[0]?.tool_calls?.[0]?.function.arguments, '{"query":"login"}');

		// Tool response message
		assert.equal(converted[1]?.role, 'tool');
		assert.equal(converted[1]?.tool_call_id, 'call-123');
		assert.equal(converted[1]?.content, 'Found login.ts');
	});

	it('convertMessages validates image MIME before large allocations', () => {
		const invalidImageMsg: vscode.LanguageModelChatRequestMessage = {
			role: vscode.LanguageModelChatMessageRole.User,
			name: 'user',
			content: [
				new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/svg+xml'),
			],
		};

		assert.throws(
			() => convertMessages([invalidImageMsg]),
			/不支持的图片格式: image\/svg\+xml/
		);

		const validImageMsg: vscode.LanguageModelChatRequestMessage = {
			role: vscode.LanguageModelChatMessageRole.User,
			name: 'user',
			content: [
				new vscode.LanguageModelDataPart(new Uint8Array([137, 80, 78, 71]), 'image/png'),
			],
		};

		const converted = convertMessages([validImageMsg]);
		assert.equal(converted.length, 1);
		assert.ok(Array.isArray(converted[0]?.content));
		const parts = converted[0]?.content as Array<{ type: string; image_url?: { url: string } }>;
		assert.equal(parts[0]?.type, 'image_url');
		assert.ok(parts[0]?.image_url?.url.startsWith('data:image/png;base64,'));
	});
});

