import * as vscode from 'vscode';
import { assetBaseUrlForPlan, getApiKey, resolveBillingPlan } from './auth';
import { keyFingerprint, lastNBillingDays } from './billingDays';
import { friendlyModelName } from './display';
import { debugStore, type ModelTurn } from './debugStore';
import { fetchDailyUsage, type DailyUsageRecord } from './platformApi';
import { formatMoney, type PricingCurrency } from './pricing';
import { getCachedBillingPlan, getCachedPlanMeta } from './statusHover';
import { formatCacheHitPercent } from './usage';

export { lastNBillingDays } from './billingDays';

export interface ModelDayStats {
	cost: number;
	cachedTok: number;
	uncachedTok: number;
	outputTok: number;
	tokens: number;
	req: number;
}

export interface DailyBillingPoint {
	label: string;
	/** ISO date yyyy-mm-dd for tooltips. */
	date: string;
	cost: number;
	flashCost: number;
	proCost: number;
	pluginCost: number;
	cachedTok: number;
	uncachedTok: number;
	outputTok: number;
	flashTok: number;
	proTok: number;
	flashReq: number;
	proReq: number;
	/** Per-model breakdown when sourced from official usage/daily. */
	byModel?: Record<string, ModelDayStats>;
}

export interface BillingModelOption {
	id: string;
	label: string;
}

export interface DebugTurnCard {
	id: string;
	model: string;
	status: string;
	duration: string;
	cache: string;
	cost: string;
	tools: number;
	meta: string;
	error?: string;
}

export interface BillingPayload {
	sourceNote: string;
	/** `official` = platform/usage/daily; `local` = debugStore fallback. */
	source: 'official' | 'local' | 'unavailable';
	currency: PricingCurrency | undefined;
	totalCostLabel: string;
	totalTokens: number;
	cachedTokens: number;
	uncachedTokens: number;
	outputTokens: number;
	cachedShareLabel: string;
	requestCount: number;
	daily: DailyBillingPoint[];
	models: BillingModelOption[];
	error?: string;
}

export interface SettingsPayload {
	keyMask: string;
	baseUrl: string;
	thinking: string;
	maxCompletionTokens: number;
	webSearch: boolean;
	currency: string;
}

function isFlashModel(modelId: string): boolean {
	return /flash/i.test(modelId);
}

function dayKey(ts: number): { key: string; label: string } {
	const d = new Date(ts);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return { key: `${y}-${m}-${day}`, label: `${m}-${day}` };
}

function formatDuration(ms: number | undefined): string {
	if (ms === undefined) {
		return '—';
	}
	if (ms >= 1000) {
		return `${(ms / 1000).toFixed(1)}s`;
	}
	return `${ms}ms`;
}

function emptyPoint(label: string, date: string): DailyBillingPoint {
	return {
		label,
		date,
		cost: 0,
		flashCost: 0,
		proCost: 0,
		pluginCost: 0,
		cachedTok: 0,
		uncachedTok: 0,
		outputTok: 0,
		flashTok: 0,
		proTok: 0,
		flashReq: 0,
		proReq: 0,
		byModel: {},
	};
}

function parseAmount(v: string | undefined): number {
	const n = Number.parseFloat(v ?? '0');
	return Number.isFinite(n) ? n : 0;
}

function asCurrency(v: string | undefined): PricingCurrency | undefined {
	if (!v) {
		return undefined;
	}
	const u = v.toUpperCase();
	if (u === 'CNY' || u === 'USD') {
		return u;
	}
	return undefined;
}

/** @deprecated Prefer {@link lastNBillingDays}. */
export function lastNUtcDays(n: number): { start: string; end: string; days: string[] } {
	return lastNBillingDays(n);
}

function finalizePayload(
	daily: DailyBillingPoint[],
	modelIds: Map<string, string>,
	opts: {
		source: BillingPayload['source'];
		sourceNote: string;
		currency?: PricingCurrency;
		error?: string;
	}
): BillingPayload {
	let totalCost = 0;
	let cachedTokens = 0;
	let uncachedTokens = 0;
	let outputTokens = 0;
	let requestCount = 0;
	for (const d of daily) {
		totalCost += d.cost;
		cachedTokens += d.cachedTok;
		uncachedTokens += d.uncachedTok;
		outputTokens += d.outputTok;
		requestCount += d.flashReq + d.proReq;
	}
	const den = cachedTokens + uncachedTokens;
	const pct = den > 0 ? ((cachedTokens / den) * 100).toFixed(2) : '0.00';
	const models: BillingModelOption[] = [...modelIds.entries()].map(([id, label]) => ({ id, label }));
	if (models.length === 0) {
		models.push(
			{ id: 'mimo-v2.6-flash', label: 'MiMo V2.6 Flash' },
			{ id: 'mimo-v2.6-pro', label: 'MiMo V2.6 Pro' }
		);
	}
	const currency = opts.currency;
	return {
		source: opts.source,
		sourceNote: opts.sourceNote,
		currency,
		totalCostLabel: currency ? formatMoney(totalCost, currency) : totalCost > 0 ? String(totalCost) : '—',
		totalTokens: cachedTokens + uncachedTokens + outputTokens,
		cachedTokens,
		uncachedTokens,
		outputTokens,
		cachedShareLabel: `${cachedTokens.toLocaleString('en-US')}（${pct}%）`,
		requestCount,
		daily,
		models,
		error: opts.error,
	};
}

/**
 * Official console mask form, e.g. `sk-****abcd` (docs sample).
 * Used to filter `/platform/usage/daily` rows to the configured Key.
 */
export function officialMaskedApiKey(apiKey: string): string {
	const k = apiKey.trim();
	if (k.length < 8) {
		return k;
	}
	const prefix = k.startsWith('ttp-')
		? 'ttp-'
		: k.startsWith('tp-')
			? 'tp-'
			: k.startsWith('sk-')
				? 'sk-'
				: `${k.slice(0, 3)}`;
	return `${prefix}****${k.slice(-4)}`;
}

function rowMatchesApiKey(row: DailyUsageRecord, apiKey: string): boolean {
	const masked = row.masked_api_key?.trim();
	if (!masked) {
		return false;
	}
	const expected = officialMaskedApiKey(apiKey);
	if (masked === expected) {
		return true;
	}
	// Tolerant match: same prefix family + same last 4 (mask asterisk count may vary).
	const tail = apiKey.trim().slice(-4);
	if (!masked.endsWith(tail)) {
		return false;
	}
	if (apiKey.trim().startsWith('sk-')) {
		return masked.startsWith('sk-');
	}
	if (apiKey.trim().startsWith('ttp-')) {
		return masked.startsWith('ttp-');
	}
	if (apiKey.trim().startsWith('tp-')) {
		return masked.startsWith('tp-');
	}
	return false;
}

/** Build chart series from official `/platform/usage/daily` rows. */
export function buildBillingPayloadFromUsage(
	records: DailyUsageRecord[],
	dayKeys: string[],
	opts?: { apiKey?: string; filterToCurrentKey?: boolean }
): BillingPayload {
	const byDay = new Map<string, DailyBillingPoint>();
	for (const key of dayKeys) {
		const label = key.slice(5);
		byDay.set(key, emptyPoint(label, key));
	}
	const modelIds = new Map<string, string>();
	let currency: PricingCurrency | undefined;
	const filterKey = opts?.filterToCurrentKey !== false && opts?.apiKey ? opts.apiKey : undefined;
	let matchedRows = 0;
	let skippedOtherKeys = 0;

	for (const row of records) {
		if (filterKey) {
			if (!rowMatchesApiKey(row, filterKey)) {
				skippedOtherKeys += 1;
				continue;
			}
			matchedRows += 1;
		}
		const date = row.date;
		if (!date || !byDay.has(date)) {
			continue;
		}
		const point = byDay.get(date)!;
		const amount = parseAmount(row.consumed_amount);
		currency = asCurrency(row.currency) ?? currency;
		point.cost += amount;

		if (row.resource_type === 'plugin') {
			point.pluginCost += amount;
			continue;
		}

		const name = (row.name || 'unknown').trim();
		modelIds.set(name, friendlyModelName(name));
		const cached = row.input_cache_hit_tokens ?? 0;
		const uncached = row.input_cache_miss_tokens ?? 0;
		const output = row.output_tokens ?? 0;
		const tokens = row.total_tokens ?? cached + uncached + output;
		const req = row.request_count ?? 0;

		point.cachedTok += cached;
		point.uncachedTok += uncached;
		point.outputTok += output;

		if (!point.byModel) {
			point.byModel = {};
		}
		const prev = point.byModel[name] ?? {
			cost: 0,
			cachedTok: 0,
			uncachedTok: 0,
			outputTok: 0,
			tokens: 0,
			req: 0,
		};
		prev.cost += amount;
		prev.cachedTok += cached;
		prev.uncachedTok += uncached;
		prev.outputTok += output;
		prev.tokens += tokens;
		prev.req += req;
		point.byModel[name] = prev;

		if (isFlashModel(name)) {
			point.flashCost += amount;
			point.flashTok += tokens;
			point.flashReq += req;
		} else {
			point.proCost += amount;
			point.proTok += tokens;
			point.proReq += req;
		}
	}

	const daily = dayKeys.map((k) => byDay.get(k)!);
	const keyHint = filterKey ? officialMaskedApiKey(filterKey) : '';
	const scopeNote = filterKey
		? `仅当前 API Key（${keyHint}）${skippedOtherKeys > 0 ? `，已排除其他 Key ${skippedOtherKeys} 条` : ''}`
		: '账户全部 API Key';
	return finalizePayload(daily, modelIds, {
		source: 'official',
		sourceNote: `来自官方日用量接口（近 7 日 · 官方按 UTC 自然日记账 · ${scopeNote}）。北京时间 08:00 前「今天」列可能为空，当日用量记在 UTC 昨日。金额为折后消费，赠金抵扣前。${
			filterKey && matchedRows === 0 && records.length > 0
				? ' 当前 Key 在区间内无用量记录。'
				: ''
		}`,
		currency,
	});
}

/** Aggregate recent turns into daily series (fallback when official usage API unavailable). */
export function buildBillingPayload(turns: readonly ModelTurn[] = debugStore.list()): BillingPayload {
	const byDay = new Map<string, DailyBillingPoint>();
	const modelIds = new Map<string, string>();
	let currency: PricingCurrency | undefined;

	for (const turn of turns) {
		if (turn.status === 'running') {
			continue;
		}
		modelIds.set(turn.model, friendlyModelName(turn.model));
		const { key, label } = dayKey(turn.created);
		let point = byDay.get(key);
		if (!point) {
			point = emptyPoint(label, key);
			byDay.set(key, point);
		}
		const flash = isFlashModel(turn.model);
		if (flash) {
			point.flashReq += 1;
		} else {
			point.proReq += 1;
		}

		const usage = turn.usage;
		if (usage) {
			const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
			const prompt = usage.prompt_tokens ?? 0;
			const completion = usage.completion_tokens ?? 0;
			const uncached = Math.max(0, prompt - cached);
			point.cachedTok += cached;
			point.uncachedTok += uncached;
			point.outputTok += completion;
			const tok = prompt + completion;
			if (flash) {
				point.flashTok += tok;
			} else {
				point.proTok += tok;
			}
			if (!point.byModel) {
				point.byModel = {};
			}
			const prev = point.byModel[turn.model] ?? {
				cost: 0,
				cachedTok: 0,
				uncachedTok: 0,
				outputTok: 0,
				tokens: 0,
				req: 0,
			};
			prev.cachedTok += cached;
			prev.uncachedTok += uncached;
			prev.outputTok += completion;
			prev.tokens += tok;
			prev.req += 1;
			point.byModel[turn.model] = prev;
		}

		if (turn.cost?.kind === 'payg') {
			currency = turn.cost.currency;
			point.cost += turn.cost.amount;
			if (flash) {
				point.flashCost += turn.cost.amount;
			} else {
				point.proCost += turn.cost.amount;
			}
			if (point.byModel?.[turn.model]) {
				point.byModel[turn.model]!.cost += turn.cost.amount;
			}
		}
	}

	const daily = [...byDay.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([, p]) => p);

	return finalizePayload(daily, modelIds, {
		source: 'local',
		sourceNote: '来自本扩展最近请求缓存（非官网完整账单）。完整历史请打开控制台。',
		currency,
	});
}

const BILLING_TTL_MS = 60_000;
const BILLING_RATE_LIMIT_COOLDOWN_MS = 90_000;
let billingCache:
	| { at: number; key: string; payload: BillingPayload }
	| undefined;
let billingInFlight: Promise<BillingPayload> | undefined;
let billingRateLimitedUntil = 0;
let billingCooldownTimer: ReturnType<typeof setTimeout> | undefined;
let billingRetryContext: vscode.ExtensionContext | undefined;

function scheduleBillingCooldownRetry(): void {
	if (!billingRetryContext || Date.now() >= billingRateLimitedUntil) {
		return;
	}
	if (billingCooldownTimer) {
		clearTimeout(billingCooldownTimer);
	}
	const ctx = billingRetryContext;
	const delay = Math.max(500, billingRateLimitedUntil - Date.now() + 300);
	billingCooldownTimer = setTimeout(() => {
		billingCooldownTimer = undefined;
		void loadBillingPayload(ctx, { force: true });
	}, delay);
}

/** Prefer official usage/daily (PAYG sk-); fall back to local debug buffer. */
export async function loadBillingPayload(
	context: vscode.ExtensionContext,
	opts?: { force?: boolean }
): Promise<BillingPayload> {
	billingRetryContext = context;
	const cfg = vscode.workspace.getConfiguration('xiaomiMimo');
	const baseUrl = cfg.get<string>('baseUrl', 'https://api.xiaomimimo.com/v1');
	const timeoutMs = Math.min(cfg.get<number>('requestTimeoutMs', 300000), 20_000);
	const apiKey = await getApiKey(context);
	const planMeta = getCachedPlanMeta();
	const plan =
		planMeta.plan !== 'unknown'
			? planMeta.plan
			: getCachedBillingPlan() !== 'unknown'
				? getCachedBillingPlan()
				: resolveBillingPlan({ apiKey, baseUrl });

	if (!apiKey) {
		const local = buildBillingPayload();
		return {
			...local,
			source: 'unavailable',
			sourceNote: '未配置 API Key，无法拉取官网日用量。',
			error: '未配置 API Key',
		};
	}

	if (plan === 'token-plan') {
		const local = buildBillingPayload();
		return {
			...local,
			source: local.daily.length ? 'local' : 'unavailable',
			sourceNote:
				'日用量接口仅支持按量 sk- Key。当前为 Token Plan，已回退本扩展最近请求；完整账单请打开控制台。',
		};
	}

	const range = lastNBillingDays(7);
	const cacheKey = `${keyFingerprint(apiKey)}:${range.start}:${range.end}`;
	const force = opts?.force === true;
	const now = Date.now();
	if (now < billingRateLimitedUntil) {
		scheduleBillingCooldownRetry();
		if (billingCache && billingCache.key === cacheKey) {
			return {
				...billingCache.payload,
				sourceNote: `${billingCache.payload.sourceNote}（日用量限流冷却中，暂用缓存）`,
			};
		}
		const local = buildBillingPayload();
		return {
			...local,
			source: local.daily.length ? 'local' : 'unavailable',
			sourceNote: '官网日用量限流 (429)，已回退本地缓存。与余额是否充足无关。',
		};
	}
	if (
		!force &&
		billingCache &&
		billingCache.key === cacheKey &&
		now - billingCache.at < BILLING_TTL_MS
	) {
		return billingCache.payload;
	}
	if (!force && billingInFlight) {
		return billingInFlight;
	}

	const assetBase = assetBaseUrlForPlan(plan === 'unknown' ? 'payg' : plan, baseUrl);
	billingInFlight = (async () => {
		try {
			const rows = await fetchDailyUsage(assetBase, apiKey, range.start, range.end, timeoutMs);
			const payload = buildBillingPayloadFromUsage(rows, range.days, {
				apiKey,
				filterToCurrentKey: true,
			});
			billingCache = { at: Date.now(), key: cacheKey, payload };
			billingRateLimitedUntil = 0;
			return payload;
		} catch (err) {
			const local = buildBillingPayload();
			const msg = String(err instanceof Error ? err.message : err);
			const rateLimited = /\b429\b/i.test(msg) || /rate[_\s-]?limit/i.test(msg);
			if (rateLimited) {
				billingRateLimitedUntil = Date.now() + BILLING_RATE_LIMIT_COOLDOWN_MS;
				scheduleBillingCooldownRetry();
			}
			if (rateLimited && billingCache && billingCache.key === cacheKey) {
				return {
					...billingCache.payload,
					sourceNote: `${billingCache.payload.sourceNote}（日用量限流，暂用缓存）`,
				};
			}
			return {
				...local,
				source: local.daily.length ? 'local' : 'unavailable',
				sourceNote: rateLimited
					? `官网日用量限流 (429)，已回退本地缓存。与余额是否充足无关。`
					: `官网日用量拉取失败，已回退本地缓存。${msg}`,
				error: msg,
			};
		} finally {
			billingInFlight = undefined;
		}
	})();

	return billingInFlight;
}

export function buildDebugTurnCards(turns: readonly ModelTurn[] = debugStore.list()): DebugTurnCard[] {
	return turns.slice(0, 50).map((turn) => {
		const cache = turn.usage ? formatCacheHitPercent(turn.usage) ?? '—' : '—';
		const cost = turn.cost?.label ?? '—';
		const duration = formatDuration(turn.durationMs);
		const tools = turn.toolCalls.length || turn.toolNames.length;
		const metaParts = [
			turn.id,
			duration,
			turn.usage ? `Cache ${cache}` : undefined,
			cost !== '—' ? cost : undefined,
			tools ? `Tools ${tools}` : undefined,
			turn.error ? turn.error.slice(0, 80) : undefined,
		].filter(Boolean);
		return {
			id: turn.id,
			model: friendlyModelName(turn.model),
			status: turn.status,
			duration,
			cache,
			cost,
			tools,
			meta: metaParts.join(' · '),
			error: turn.error,
		};
	});
}

export function maskApiKey(apiKey: string | undefined): string {
	if (!apiKey) {
		return '未配置';
	}
	const k = apiKey.trim();
	if (k.length <= 8) {
		return '••••••••';
	}
	return `${k.slice(0, 3)}••••••••${k.slice(-4)}`;
}

export function buildSettingsPayload(
	apiKey: string | undefined,
	cfg: vscode.WorkspaceConfiguration
): SettingsPayload {
	const baseUrl = cfg.get<string>('baseUrl', 'https://api.xiaomimimo.com/v1');
	return {
		keyMask: maskApiKey(apiKey),
		baseUrl: baseUrl.replace(/^https?:\/\//, ''),
		thinking: cfg.get<string>('thinking', 'auto'),
		maxCompletionTokens: cfg.get<number>('maxCompletionTokens', 131072),
		webSearch: cfg.get<boolean>('webSearch', false),
		currency: cfg.get<string>('estimateCurrency', 'auto'),
	};
}
