import * as vscode from 'vscode';
import { getApiKey, resolveBillingPlan } from './auth';
import { friendlyModelName } from './display';
import { formatMoney, PRICE_SOURCE, type CostEstimate } from './pricing';
import { sessionStats } from './sessionStats';
import { getCachedAccountSnapshot, getCachedPlanMeta } from './statusHover';
import { formatCacheHitPercent, formatTtft } from './usage';

export interface OverviewPayload {
	plan: 'payg' | 'token-plan' | 'unknown';
	consoleTitle: string;
	modelName: string;
	costLabel: string;
	breakdown: string;
	barWidths: { a: number; b: number; c: number };
	balanceLabel: string;
	balanceHint: string;
	balanceError?: string;
	quotaHero: string;
	quotaReset: string;
	quotaUsedPercent: number;
	quotaExhausted: boolean;
	quotaError?: string;
	tokPerSec: string;
	cache: string;
	ttft: string;
	prompt: string;
	completion: string;
	cached: string;
	uncached: string;
	sessionTurns: number;
	sessionCostLabel: string;
	priceSource: string;
	iconUri: string;
	/** Account snapshot may be TTL-stale or held during 429 cooldown. */
	accountStale: boolean;
	accountRateLimited: boolean;
	accountFreshnessNote?: string;
}

export function costBarWidths(cost: CostEstimate | undefined): { a: number; b: number; c: number } {
	if (!cost || cost.kind !== 'payg' || cost.amount <= 0) {
		return { a: 0, b: 0, c: 0 };
	}
	const [uncached, cached, output] = cost.parts;
	const total = cost.amount;
	return {
		a: Math.max(0, ((uncached?.amount ?? 0) / total) * 100),
		b: Math.max(0, ((cached?.amount ?? 0) / total) * 100),
		c: Math.max(0, ((output?.amount ?? 0) / total) * 100),
	};
}

export async function buildOverviewPayload(
	context: vscode.ExtensionContext,
	webview: vscode.Webview,
	kind: 'dark' | 'light' = 'dark'
): Promise<OverviewPayload> {
	const cfg = vscode.workspace.getConfiguration('xiaomiMimo');
	const baseUrl = cfg.get<string>('baseUrl', 'https://api.xiaomimimo.com/v1');
	const snap = sessionStats.snapshot();
	const apiKey = await getApiKey(context);
	const planMeta = getCachedPlanMeta();
	const resolved = resolveBillingPlan({ apiKey, baseUrl });
	const plan: OverviewPayload['plan'] =
		planMeta.plan !== 'unknown'
			? planMeta.plan
			: resolved !== 'unknown'
				? resolved
				: snap.plan !== 'unknown'
					? snap.plan
					: 'unknown';
	const last = snap.last;
	const usage = last?.usage;
	const cost = last?.cost;
	const iconFile = kind === 'light' ? 'mimo-icon-light.svg' : 'mimo-icon-dark.svg';
	const iconUri = webview
		.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', iconFile))
		.toString();
	const prompt = usage?.prompt_tokens ?? 0;
	const completion = usage?.completion_tokens ?? 0;
	const cachedTok = usage?.prompt_tokens_details?.cached_tokens ?? 0;
	const uncached = Math.max(0, prompt - cachedTok);
	const hit = usage ? formatCacheHitPercent(usage) : undefined;
	const ttft = formatTtft(last?.ttftMs);

	// Account fields come only from refreshAccountCache — never double-hit /platform/balance.
	const account = getCachedAccountSnapshot();
	let balanceLabel = account.balanceLabel;
	let balanceHint = account.balanceHint;
	let balanceError = account.balanceError;
	let quotaHero = account.quotaHero;
	let quotaReset = account.quotaReset;
	let quotaUsedPercent = account.quotaUsedPercent;
	let quotaExhausted = account.quotaExhausted;
	let quotaError = account.quotaError;

	if (!apiKey) {
		balanceLabel = '—';
		balanceHint = '未配置 API Key';
		balanceError = '未配置 API Key';
		quotaHero = '额度不可用';
		quotaError = '未配置 API Key';
	}
	const mismatch = planMeta.mismatch ?? account.mismatch;
	if (mismatch) {
		balanceError = balanceError ? `${balanceError}；${mismatch}` : mismatch;
	}

	const costLabel =
		cost?.kind === 'payg' ? cost.label : cost?.kind === 'token-plan' ? cost.label : last ? 'N/A' : '—';

	const freshnessNote = account.rateLimited
		? '账户数据为限流缓存，冷却后将自动重试。'
		: account.stale
			? '账户数据可能已过期，打开侧栏或点刷新可更新。'
			: undefined;

	return {
		plan,
		consoleTitle: plan === 'token-plan' ? '打开 Token Plan 控制台' : '打开官方控制台',
		modelName: last ? friendlyModelName(last.modelId) : '—',
		costLabel,
		breakdown: cost?.kind === 'payg' ? cost.breakdown : '',
		barWidths: costBarWidths(cost),
		balanceLabel,
		balanceHint,
		balanceError,
		quotaHero,
		quotaReset,
		quotaUsedPercent,
		quotaExhausted,
		quotaError,
		tokPerSec: last?.tokPerSec !== undefined ? String(Math.round(last.tokPerSec)) : '—',
		cache: hit ?? '—',
		ttft: ttft ?? '—',
		prompt: prompt.toLocaleString('en-US'),
		completion: completion.toLocaleString('en-US'),
		cached: cachedTok.toLocaleString('en-US'),
		uncached: uncached.toLocaleString('en-US'),
		sessionTurns: snap.turnCount,
		sessionCostLabel:
			snap.sessionCostLabel ?? (snap.sessionCurrency ? formatMoney(0, snap.sessionCurrency) : '—'),
		priceSource: PRICE_SOURCE,
		iconUri,
		accountStale: account.stale,
		accountRateLimited: account.rateLimited,
		accountFreshnessNote: freshnessNote,
	};
}
