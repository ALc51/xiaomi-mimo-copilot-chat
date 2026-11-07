import * as vscode from 'vscode';
import {
	assetBaseUrlForPlan,
	getApiKey,
	planDisplayName,
	resolveBillingPlan,
	type KeyPlanHint,
} from './auth';
import { friendlyModelName } from './display';
import {
	detectBillingPlan,
	fetchPaygBalance,
	fetchTokenPlanQuota,
	formatResetHint,
	isPaygBalanceExhausted,
} from './platformApi';
import { formatBalanceAmount } from './pricing';
import { sessionStats } from './sessionStats';

export const STATUS_HOVER_REFRESH_COMMAND = 'xiaomi-mimo.status.refreshHover';

/** Soft TTL — balance/quota rarely need sub-minute freshness. */
const FETCH_TTL_MS = 60_000;
/** After HTTP 429, pause asset calls so we don't hammer the platform. */
const RATE_LIMIT_COOLDOWN_MS = 90_000;

let cachedBalanceLabel: string | undefined;
let cachedBalanceHint: string | undefined;
let cachedBalanceError: string | undefined;
let cachedQuotaHero: string | undefined;
let cachedQuotaReset: string | undefined;
let cachedQuotaError: string | undefined;
let cachedQuotaUsedPercent = 0;
let cachedExhausted = false;
let cachedPlan: KeyPlanHint = 'unknown';
let cachedPlanSource: 'key' | 'baseUrl' | 'probe' | 'unknown' = 'unknown';
let cachedPlanMismatch: string | undefined;
let lastFetchAt = 0;
let rateLimitedUntil = 0;
let fetchInFlight: Promise<void> | undefined;
let cooldownTimer: ReturnType<typeof setTimeout> | undefined;
let retryContext: vscode.ExtensionContext | undefined;
const accountListeners = new Set<() => void>();

/** Fire when cached balance/quota changes (incl. auto-retry after 429). */
export function onAccountCacheChange(listener: () => void): vscode.Disposable {
	accountListeners.add(listener);
	return {
		dispose: () => {
			accountListeners.delete(listener);
		},
	};
}

function notifyAccountCacheChange(): void {
	for (const listener of accountListeners) {
		try {
			listener();
		} catch {
			/* ignore listener errors */
		}
	}
}

function scheduleCooldownRetry(): void {
	if (!retryContext || Date.now() >= rateLimitedUntil) {
		return;
	}
	if (cooldownTimer) {
		clearTimeout(cooldownTimer);
	}
	const delay = Math.max(500, rateLimitedUntil - Date.now() + 300);
	const ctx = retryContext;
	cooldownTimer = setTimeout(() => {
		cooldownTimer = undefined;
		void refreshAccountCache(ctx, false);
	}, delay);
}

export function getCachedQuotaExhausted(): boolean {
	return cachedExhausted;
}

export function getCachedBillingPlan(): KeyPlanHint {
	return cachedPlan;
}

export function getCachedPlanMeta(): {
	plan: KeyPlanHint;
	source: typeof cachedPlanSource;
	mismatch?: string;
	label: string;
} {
	return {
		plan: cachedPlan,
		source: cachedPlanSource,
		mismatch: cachedPlanMismatch,
		label: planDisplayName(cachedPlan),
	};
}

/** Snapshot for overview UI — never hits the network. */
export function getCachedAccountSnapshot(): {
	plan: KeyPlanHint;
	balanceLabel: string;
	balanceHint: string;
	balanceError?: string;
	quotaHero: string;
	quotaReset: string;
	quotaUsedPercent: number;
	quotaExhausted: boolean;
	quotaError?: string;
	mismatch?: string;
	stale: boolean;
	rateLimited: boolean;
} {
	const now = Date.now();
	return {
		plan: cachedPlan,
		balanceLabel: cachedBalanceLabel ?? '…',
		balanceHint: cachedBalanceHint ?? '按量充值余额',
		balanceError: cachedBalanceError,
		quotaHero: cachedQuotaHero ?? '…',
		quotaReset: cachedQuotaReset ?? '',
		quotaUsedPercent: cachedQuotaUsedPercent,
		quotaExhausted: cachedExhausted,
		quotaError: cachedQuotaError,
		mismatch: cachedPlanMismatch,
		stale: lastFetchAt === 0 || now - lastFetchAt > FETCH_TTL_MS,
		rateLimited: now < rateLimitedUntil,
	};
}

function isRateLimitError(err: unknown): boolean {
	const msg = String(err instanceof Error ? err.message : err);
	return /\b429\b/i.test(msg) || /rate[_\s-]?limit/i.test(msg);
}

function rateLimitMessage(): string {
	const secs = Math.max(1, Math.ceil((rateLimitedUntil - Date.now()) / 1000));
	return `资产接口限流 (429)，已暂停拉取约 ${secs}s；显示为缓存，与账户余额是否充足无关。`;
}

/** Short status-bar tooltip; full UI is the control center. */
export function buildStatusHoverMarkdown(): vscode.MarkdownString {
	const snap = sessionStats.snapshot();
	const last = snap.last;
	const cost = last?.cost?.kind === 'payg' ? last.cost.label : last?.cost?.label;
	const model = last ? friendlyModelName(last.modelId) : undefined;
	const account = getCachedAccountSnapshot();
	const planLine =
		account.plan === 'unknown' ? '' : `套餐 ${planDisplayName(account.plan)}（自动识别）`;
	const assetLine =
		account.plan === 'token-plan'
			? account.quotaHero
				? `额度 ${account.quotaHero}`
				: ''
			: account.balanceLabel
				? `余额 ${account.balanceLabel}`
				: '';
	const staleNote = account.rateLimited ? '（限流缓存）' : account.stale ? '（可能过期）' : '';
	const lines = [
		'**Xiaomi MiMo** — 点击打开/关闭控制中心',
		'',
		planLine,
		assetLine ? `${assetLine}${staleNote}` : '',
		model ? `最近 ${model}${cost ? ` · ${cost}` : ''}` : '发送对话后显示本轮费用与性能',
	].filter(Boolean);
	const md = new vscode.MarkdownString(lines.join('\n'), true);
	md.isTrusted = true;
	return md;
}

/**
 * Refresh PAYG balance / Token Plan quota into memory.
 * - `force=false` (default): skip if within TTL or mid-flight.
 * - `force=true`: user-driven refresh; still respects active 429 cooldown.
 * On 429, schedules a single automatic retry after cooldown (no manual refresh).
 */
export async function refreshAccountCache(
	context: vscode.ExtensionContext,
	force = false
): Promise<boolean> {
	retryContext = context;
	const now = Date.now();
	if (!force && now - lastFetchAt < FETCH_TTL_MS && fetchInFlight === undefined) {
		return cachedExhausted;
	}
	if (now < rateLimitedUntil) {
		if (cachedPlan === 'payg') {
			cachedBalanceError = rateLimitMessage();
		} else if (cachedPlan === 'token-plan') {
			cachedQuotaError = rateLimitMessage();
		}
		scheduleCooldownRetry();
		notifyAccountCacheChange();
		return cachedExhausted;
	}
	if (fetchInFlight) {
		await fetchInFlight;
		return cachedExhausted;
	}

	fetchInFlight = (async () => {
		const cfg = vscode.workspace.getConfiguration('xiaomiMimo');
		const baseUrl = cfg.get<string>('baseUrl', 'https://api.xiaomimimo.com/v1');
		const timeoutMs = Math.min(cfg.get<number>('requestTimeoutMs', 300000), 15_000);
		const apiKey = await getApiKey(context);

		cachedBalanceError = undefined;
		cachedQuotaError = undefined;
		cachedPlanMismatch = undefined;

		if (!apiKey) {
			cachedPlan = resolveBillingPlan({ baseUrl });
			cachedPlanSource = cachedPlan === 'unknown' ? 'unknown' : 'baseUrl';
			cachedBalanceLabel = '—';
			cachedBalanceHint = '未配置 API Key';
			cachedBalanceError = '未配置 API Key';
			cachedQuotaHero = '额度不可用';
			cachedQuotaError = '未配置 API Key';
			cachedQuotaUsedPercent = 0;
			cachedExhausted = false;
			lastFetchAt = Date.now();
			return;
		}

		const detected = await detectBillingPlan(apiKey, baseUrl, timeoutMs);
		cachedPlan = detected.plan;
		cachedPlanSource = detected.source;
		cachedPlanMismatch = detected.mismatch;

		const assetBase = assetBaseUrlForPlan(cachedPlan, baseUrl);

		if (cachedPlan === 'token-plan') {
			try {
				const quota = await fetchTokenPlanQuota(assetBase, apiKey, timeoutMs);
				cachedQuotaHero = `${quota.usedPercent}% 已使用`;
				cachedQuotaReset = formatResetHint(quota.periodEnd);
				cachedQuotaUsedPercent = quota.usedPercent;
				cachedExhausted = quota.exhausted;
				cachedQuotaError = undefined;
			} catch (err) {
				if (isRateLimitError(err)) {
					rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
					cachedQuotaError = rateLimitMessage();
				} else {
					cachedQuotaHero = cachedQuotaHero && cachedQuotaHero !== '…' ? cachedQuotaHero : '额度不可用';
					cachedQuotaError = String(err instanceof Error ? err.message : err);
				}
			}
		} else if (cachedPlan === 'payg') {
			try {
				const balance = await fetchPaygBalance(assetBase, apiKey, timeoutMs);
				cachedBalanceLabel = formatBalanceAmount(balance.totalAvailable, balance.currency);
				cachedBalanceHint = `现金 ${formatBalanceAmount(balance.cashBalance, balance.currency)} · 赠金 ${formatBalanceAmount(balance.giftBalance, balance.currency)}`;
				cachedBalanceError = undefined;
				cachedExhausted = isPaygBalanceExhausted(balance);
			} catch (err) {
				if (isRateLimitError(err)) {
					rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
					cachedBalanceError = rateLimitMessage();
					// Keep last successful balanceLabel if any.
					if (!cachedBalanceLabel || cachedBalanceLabel === '—' || cachedBalanceLabel === '…') {
						cachedBalanceLabel = '—';
					}
				} else {
					cachedBalanceLabel = '—';
					cachedBalanceHint = '按量充值余额';
					cachedBalanceError = String(err instanceof Error ? err.message : err);
					cachedExhausted = false;
				}
			}
		} else {
			cachedBalanceLabel = '—';
			cachedBalanceHint = '未能识别套餐';
			cachedBalanceError = '无法从 Key / Base URL / 资产接口识别按量或 Token Plan';
			cachedQuotaHero = '额度不可用';
			cachedQuotaError = cachedBalanceError;
			cachedQuotaUsedPercent = 0;
			cachedExhausted = false;
		}
		// On 429, clear TTL so soft refresh retries automatically after cooldown.
		if (Date.now() < rateLimitedUntil) {
			lastFetchAt = 0;
			scheduleCooldownRetry();
		} else {
			lastFetchAt = Date.now();
		}
	})();

	try {
		await fetchInFlight;
	} finally {
		fetchInFlight = undefined;
	}
	notifyAccountCacheChange();
	return cachedExhausted;
}

export function registerStatusHover(
	context: vscode.ExtensionContext,
	applyHover: () => void,
	onExhaustedChange?: (exhausted: boolean) => void
): void {
	retryContext = context;

	const bump = async (force = false) => {
		const exhausted = await refreshAccountCache(context, force);
		onExhaustedChange?.(exhausted);
		applyHover();
	};

	context.subscriptions.push(
		vscode.commands.registerCommand(STATUS_HOVER_REFRESH_COMMAND, () => {
			void bump(true);
		}),
		sessionStats.onChange(() => {
			applyHover();
			// Soft refresh — auto when TTL expires; no manual click needed.
			void bump(false);
		}),
		onAccountCacheChange(() => {
			applyHover();
		}),
		{
			dispose: () => {
				if (cooldownTimer) {
					clearTimeout(cooldownTimer);
					cooldownTimer = undefined;
				}
				accountListeners.clear();
				retryContext = undefined;
			},
		}
	);

	void bump(true);
}
