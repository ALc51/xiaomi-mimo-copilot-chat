import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { getApiKey, promptAndSaveApiKey, checkKeyBaseUrlConsistency } from './auth';
import { fetchChatModels, fallbackModelInfos, invalidateModelCache } from './models';
import { convertMessages, convertTools, mapToolChoice } from './messageConverter';
import { streamChatCompletions, ChatCompletionRequest } from './mimoClient';
import { createUsageDataPart, formatUsageLog, ApiUsage } from './usage';
import { CostEstimate, estimateTurnCost } from './pricing';
import { MimoApiError, toUserFacingError } from './errors';
import { PerfStatus } from './perfStatus';
import { sessionStats } from './sessionStats';
import {
	buildMessagesPreview,
	formatRequestBodyPreview,
	formatRequestEnd,
	formatRequestStart,
	summarizeMessages,
	toolNamesFromBody,
	truncate,
} from './debugLog';
import { debugStore, ModelTurn, ModelTurnToolCall } from './debugStore';

export class MimoChatModelProvider implements vscode.LanguageModelChatProvider {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly perf: PerfStatus
	) {}

	/** Notify Copilot Chat to refresh the model list (e.g. after API key change). */
	notifyChanged(): void {
		invalidateModelCache();
		this._onDidChange.fire();
	}

	private settings() {
		const cfg = vscode.workspace.getConfiguration('xiaomiMimo');
		return {
			baseUrl: cfg.get<string>('baseUrl', 'https://api.xiaomimimo.com/v1'),
			thinking: cfg.get<'auto' | 'enabled' | 'disabled'>('thinking', 'auto'),
			maxCompletionTokens: cfg.get<number>('maxCompletionTokens', 131072),
			webSearch: cfg.get<boolean>('webSearch', false),
			timeoutMs: cfg.get<number>('requestTimeoutMs', 300000),
			debugLogRequests: cfg.get<boolean>('debugLogRequests', false),
			debugLogBodies: cfg.get<boolean>('debugLogBodies', false),
			estimateCurrency: cfg.get<'auto' | 'cny' | 'usd'>('estimateCurrency', 'auto'),
		};
	}

	async provideLanguageModelChatInformation(
		options: { silent: boolean },
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation[]> {
		let apiKey = await getApiKey(this.context);
		if (!apiKey) {
			// Non-silent (e.g. Manage Models): may prompt. Silent / after clearKey: no catalog.
			if (!options.silent) {
				apiKey = await promptAndSaveApiKey(this.context);
			}
			if (!apiKey) {
				this.perf.log('No API key; returning empty model list (VS Code silent / cleared key).');
				return [];
			}
		}

		const { baseUrl, timeoutMs } = this.settings();
		const mismatch = checkKeyBaseUrlConsistency(apiKey, baseUrl);
		if (mismatch) {
			this.perf.log(mismatch);
			if (!options.silent) {
				void vscode.window.showWarningMessage(mismatch);
			}
			// Still list models only when Key/URL are consistent enough to call discovery.
			// Hard mismatch → empty list so UI does not look "configured".
			return [];
		}

		try {
			return await fetchChatModels(baseUrl, apiKey, timeoutMs);
		} catch (err) {
			this.perf.log(`Model discovery failed, using fallback: ${String(err)}`);
			return fallbackModelInfos();
		}
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		// Always log entry so Output can prove Copilot actually routed to this provider.
		this.perf.log(
			`provideLanguageModelChatResponse model=${model.id} messages=${messages.length} tools=${options.tools?.length ?? 0}`
		);
		const apiKey = await getApiKey(this.context);
		if (!apiKey) {
			throw new Error('未配置 Xiaomi MiMo API Key。请运行命令 “Xiaomi MiMo: Manage API Key”。');
		}

		const settings = this.settings();
		const mismatch = checkKeyBaseUrlConsistency(apiKey, settings.baseUrl);
		if (mismatch) {
			throw new Error(`${mismatch} 请修正设置中的 Base URL，或更换匹配的 API Key。`);
		}

		const openaiMessages = convertMessages(messages);
		const functionTools = convertTools(options.tools);
		const tools: Array<Record<string, unknown>> = [...(functionTools ?? [])];
		if (settings.webSearch) {
			tools.push({
				type: 'web_search',
				max_keyword: 3,
				force_search: false,
			});
		}
		const hasTools = tools.length > 0;

		// Official FAQ: disable thinking when invoking tools for stable tool_calls.
		// Count both Copilot function tools and injected web_search.
		let thinkingType: 'enabled' | 'disabled' = 'disabled';
		if (settings.thinking === 'disabled') {
			thinkingType = 'disabled';
		} else if (hasTools) {
			thinkingType = 'disabled';
			if (settings.thinking === 'enabled') {
				this.perf.log(
					'thinking=enabled 但本轮含 tools/web_search，已按官方建议强制 disabled 以保证 tool_calls 稳定。'
				);
			}
		} else if (settings.thinking === 'enabled' || settings.thinking === 'auto') {
			thinkingType = 'enabled';
		}

		const body: ChatCompletionRequest = {
			model: model.id,
			messages: openaiMessages,
			stream: true,
			stream_options: { include_usage: true },
			max_completion_tokens: settings.maxCompletionTokens,
			thinking: { type: thinkingType },
		};

		if (thinkingType === 'enabled') {
			body.temperature = 1.0;
			body.top_p = 0.95;
		}

		if (hasTools) {
			body.tools = tools;
			body.tool_choice = mapToolChoice(options.toolMode, true);
		}

		const modelOptions = options.modelOptions as Record<string, unknown> | undefined;
		if (modelOptions?.response_format) {
			body.response_format = modelOptions.response_format;
		}

		const abort = new AbortController();
		const sub = token.onCancellationRequested(() => abort.abort());
		const started = Date.now();
		let completionTokensForSpeed = 0;
		let firstTokenAt: number | undefined;
		let textChars = 0;
		let thinkingChars = 0;
		let textChunkCount = 0;
		let thinkingChunkCount = 0;
		let responseText = '';
		let thinkingText = '';
		let lastUsage: ApiUsage | undefined;
		let lastCost: CostEstimate | undefined;
		let lastStoreFlush = 0;
		let lastFinishReason: string | undefined;
		const abnormalFinishNotes: string[] = [];
		const toolCalls: ModelTurnToolCall[] = [];
		const requestId = randomUUID().slice(0, 8);
		const debug = settings.debugLogRequests;
		const messageSummary = summarizeMessages(openaiMessages);
		const requestOptions: Record<string, unknown> = {
			thinking: thinkingType,
			tool_choice: body.tool_choice,
			max_completion_tokens: settings.maxCompletionTokens,
			temperature: body.temperature,
			top_p: body.top_p,
			web_search: settings.webSearch,
			response_format: body.response_format ? true : undefined,
		};

		const markFirstByte = (label: string): void => {
			if (firstTokenAt !== undefined) {
				return;
			}
			firstTokenAt = Date.now();
			if (debug) {
				this.perf.log(`request ${requestId}: first ${label} after ${firstTokenAt - started}ms`);
			}
		};

		const snapshot = (partial: Partial<ModelTurn>): ModelTurn => ({
			id: requestId,
			model: model.id,
			baseUrl: settings.baseUrl,
			created: started,
			status: 'running',
			requestOptions,
			messageCount: openaiMessages.length,
			messageSummary,
			messagesPreview: buildMessagesPreview(openaiMessages),
			toolNames: toolNamesFromBody(body.tools),
			toolCalls: [...toolCalls],
			responseTextPreview: truncate(responseText, 1200),
			thinkingTextPreview: truncate(thinkingText, 800),
			textChars,
			thinkingChars,
			textChunkCount,
			thinkingChunkCount,
			usage: lastUsage,
			cost: lastCost,
			ttftMs: firstTokenAt !== undefined ? firstTokenAt - started : undefined,
			durationMs: Date.now() - started,
			...partial,
		});

		const flushStore = (partial: Partial<ModelTurn>, force = false): void => {
			const now = Date.now();
			if (!force && now - lastStoreFlush < 250) {
				return;
			}
			lastStoreFlush = now;
			debugStore.upsert(snapshot(partial));
		};

		flushStore({ status: 'running' }, true);

		if (debug) {
			this.perf.log(
				formatRequestStart({
					requestId,
					baseUrl: settings.baseUrl,
					model: model.id,
					thinking: thinkingType,
					toolCount: tools.length,
					toolChoice: typeof body.tool_choice === 'string' ? body.tool_choice : undefined,
					messageCount: openaiMessages.length,
					messageSummary,
					maxCompletionTokens: settings.maxCompletionTokens,
					webSearch: settings.webSearch,
				})
			);
			if (settings.debugLogBodies) {
				this.perf.log(formatRequestBodyPreview(body));
			}
		}

		try {
			await streamChatCompletions(settings.baseUrl, apiKey, body, settings.timeoutMs, {
				signal: abort.signal,
				onText: (text) => {
					markFirstByte('token');
					textChunkCount += 1;
					textChars += text.length;
					if (responseText.length < 4000) {
						responseText += text;
					}
					progress.report(new vscode.LanguageModelTextPart(text));
					flushStore({ status: 'running' });
				},
				onThinking: (text, id) => {
					markFirstByte('thinking');
					thinkingChunkCount += 1;
					thinkingChars += text.length;
					if (thinkingText.length < 2000) {
						thinkingText += text;
					}
					const vs = vscode as unknown as {
						LanguageModelThinkingPart?: new (v: string, id?: string) => vscode.LanguageModelResponsePart;
					};
					if (typeof vs.LanguageModelThinkingPart === 'function') {
						progress.report(new vs.LanguageModelThinkingPart(text, id || randomUUID()));
					}
					flushStore({ status: 'running' });
				},
				onToolCall: (call) => {
					markFirstByte('tool_call');
					let input: object = {};
					try {
						input = JSON.parse(call.arguments || '{}') as object;
					} catch {
						input = { raw: call.arguments };
					}
					toolCalls.push({
						id: call.id,
						name: call.name,
						argumentsPreview: truncate(call.arguments || '', 400),
					});
					if (debug) {
						this.perf.log(`request ${requestId}: tool_call ${call.name} id=${call.id}`);
					}
					progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, input));
					flushStore({ status: 'running' }, true);
				},
				onUsage: (usage) => {
					lastUsage = usage;
					completionTokensForSpeed = usage.completion_tokens;
					progress.report(createUsageDataPart(usage));
					const streamSec = firstTokenAt ? Math.max(0.001, (Date.now() - firstTokenAt) / 1000) : Math.max(0.001, (Date.now() - started) / 1000);
					const tokPerSec = completionTokensForSpeed > 0 ? completionTokensForSpeed / streamSec : undefined;
					const ttftMs = firstTokenAt !== undefined ? firstTokenAt - started : undefined;
					lastCost = estimateTurnCost({
						model: model.id,
						usage,
						baseUrl: settings.baseUrl,
						currencyMode: settings.estimateCurrency,
					});
					const costDetail =
						lastCost.kind === 'payg'
							? `${lastCost.label} (${lastCost.breakdown}) · ${lastCost.priceSource}`
							: `${lastCost.label} — ${lastCost.note}`;
					flushStore({ status: 'running' }, true);
					this.perf.log(formatUsageLog(usage, tokPerSec, ttftMs, lastCost.label));
					this.perf.update(usage, tokPerSec, ttftMs, lastCost.label, costDetail);
				},
				onFinishReason: (reason) => {
					lastFinishReason = reason;
					const note = describeAbnormalFinishReason(reason);
					if (note) {
						abnormalFinishNotes.push(note);
						this.perf.log(`request ${requestId}: finish_reason=${reason} — ${note}`);
						progress.report(new vscode.LanguageModelTextPart(`\n\n⚠️ ${note}`));
					} else if (debug) {
						this.perf.log(`request ${requestId}: finish_reason=${reason}`);
					}
				},
			});
			const durationMs = Date.now() - started;
			const ttftMs = firstTokenAt !== undefined ? firstTokenAt - started : undefined;
			if (lastUsage) {
				const streamSec = firstTokenAt
					? Math.max(0.001, (Date.now() - firstTokenAt) / 1000)
					: Math.max(0.001, durationMs / 1000);
				const tokPerSec =
					lastUsage.completion_tokens > 0 ? lastUsage.completion_tokens / streamSec : undefined;
				sessionStats.recordTurn({
					modelId: model.id,
					usage: lastUsage,
					tokPerSec,
					ttftMs,
					cost: lastCost,
					baseUrl: settings.baseUrl,
				});
			}
			const finishNote =
				abnormalFinishNotes.length > 0
					? abnormalFinishNotes[abnormalFinishNotes.length - 1]
					: undefined;
			flushStore(
				{
					status: finishNote ? 'failure' : 'success',
					durationMs,
					ttftMs,
					error: finishNote ? `finish_reason=${lastFinishReason}: ${finishNote}` : undefined,
				},
				true
			);
			if (debug) {
				this.perf.log(
					formatRequestEnd({
						requestId,
						ok: !finishNote,
						durationMs,
						ttftMs,
						textChars,
						thinkingChars,
						toolCalls,
						usage: lastUsage,
						error: finishNote,
					})
				);
				this.perf.log(
					`request ${requestId}: stream text_chunks=${textChunkCount} thinking_chunks=${thinkingChunkCount} avg_text_chars=${textChunkCount ? Math.round(textChars / textChunkCount) : 0}`
				);
			}
		} catch (err) {
			const durationMs = Date.now() - started;
			const ttftMs = firstTokenAt !== undefined ? firstTokenAt - started : undefined;
			if (token.isCancellationRequested || abort.signal.aborted) {
				flushStore({ status: 'canceled', durationMs, ttftMs, error: 'cancelled' }, true);
				if (debug) {
					this.perf.log(
						formatRequestEnd({
							requestId,
							ok: false,
							durationMs,
							ttftMs,
							textChars,
							thinkingChars,
							toolCalls,
							usage: lastUsage,
							error: 'cancelled',
						})
					);
				}
				throw new vscode.CancellationError();
			}
			const mapped = toUserFacingError(err);
			if (err instanceof MimoApiError && err.status === 402) {
				this.perf.setQuotaExhausted(true);
			}
			flushStore({ status: 'failure', durationMs, ttftMs, error: mapped.message }, true);
			if (debug) {
				this.perf.log(
					formatRequestEnd({
						requestId,
						ok: false,
						durationMs,
						ttftMs,
						textChars,
						thinkingChars,
						toolCalls,
						usage: lastUsage,
						error: mapped.message,
					})
				);
			} else {
				this.perf.log(`Error: ${mapped.message}`);
			}
			throw mapped;
		} finally {
			sub.dispose();
		}
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken
	): Promise<number> {
		if (typeof text === 'string') {
			return estimateTokens(text);
		}
		let total = 0;
		for (const part of text.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				total += estimateTokens(part.value);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				total += estimateTokens(part.name) + estimateTokens(JSON.stringify(part.input ?? {}));
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				for (const c of part.content) {
					if (c instanceof vscode.LanguageModelTextPart) {
						total += estimateTokens(c.value);
					} else {
						total += estimateTokens(JSON.stringify(c));
					}
				}
			} else if (part instanceof vscode.LanguageModelDataPart) {
				// Rough image token estimate; Copilot also categorizes as files
				total += Math.max(256, Math.ceil(part.data.byteLength / 750));
			} else {
				const r = part as { value?: string | string[]; constructor?: { name?: string } };
				if (r?.constructor?.name === 'LanguageModelThinkingPart' && r.value !== undefined) {
					const v = r.value;
					total += estimateTokens(Array.isArray(v) ? v.join('') : String(v));
				}
			}
		}
		return Math.max(1, total);
	}
}

function estimateTokens(s: string): number {
	if (!s) {
		return 0;
	}
	// Mix of CJK / Latin heuristic
	let cjk = 0;
	let other = 0;
	for (const ch of s) {
		if (/[\u3400-\u9FFF]/.test(ch)) {
			cjk++;
		} else {
			other++;
		}
	}
	return Math.ceil(cjk / 1.5 + other / 4);
}

/** User-facing note for non-normal MiMo finish_reason values; undefined for stop/tool_calls. */
function describeAbnormalFinishReason(reason: string): string | undefined {
	switch (reason) {
		case 'stop':
		case 'tool_calls':
			return undefined;
		case 'length':
			return '输出因达到 max_completion_tokens 上限被截断。可增大 xiaomiMimo.maxCompletionTokens，或关闭深度思考以留给最终回答更多空间。';
		case 'content_filter':
			return '输出被内容安全策略拦截（finish_reason=content_filter）。请调整输入后重试。';
		case 'repetition_truncation':
			return '检测到复读，输出已提前截断（finish_reason=repetition_truncation）。';
		default:
			return `模型异常结束（finish_reason=${reason}）。`;
	}
}

export function onConfigChanged(): void {
	invalidateModelCache();
}
