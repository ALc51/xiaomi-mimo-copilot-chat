/** Official billing / quota APIs: https://mimo.mi.com/docs/zh-CN/api/asset/ */

import {
	PAYG_BASE_URL,
	TOKEN_PLAN_BASE_URL,
	classifyBaseUrl,
	resolveBillingPlan,
	type KeyPlanHint,
} from './auth';

export interface PaygBalance {
	currency: string;
	cashBalance: string;
	giftBalance: string;
	frozenBalance: string;
	totalAvailable: string;
	isAvailable: boolean;
}

export interface TokenPlanQuota {
	planCode: string;
	periodStart: string;
	periodEnd: string;
	totalCredits: number;
	usedCredits: number;
	remainingCredits: number;
	autoRenew: boolean;
	exhausted: boolean;
	/** 0–100 */
	usedPercent: number;
}

interface BalanceResponse {
	object?: string;
	is_available?: boolean;
	balance_infos?: Array<{
		currency?: string;
		cash_balance?: string;
		gift_balance?: string;
		frozen_balance?: string;
		total_available?: string;
	}>;
}

interface TokenPlanResponse {
	object?: string;
	plan_code?: string;
	period?: { start_at?: string; end_at?: string };
	quota?: {
		total_credits?: number;
		used_credits?: number;
		remaining_credits?: number;
	};
	auto_renew?: boolean;
}

function normalizeBase(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, '');
}

async function getJson<T>(url: string, apiKey: string, timeoutMs: number): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'api-key': apiKey,
				'Content-Type': 'application/json',
			},
			signal: controller.signal,
		});
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
		}
		return (await res.json()) as T;
	} finally {
		clearTimeout(timer);
	}
}

export async function fetchPaygBalance(
	baseUrl: string,
	apiKey: string,
	timeoutMs = 15_000
): Promise<PaygBalance> {
	const body = await getJson<BalanceResponse>(
		`${normalizeBase(baseUrl)}/platform/balance`,
		apiKey,
		timeoutMs
	);
	const info = body.balance_infos?.[0];
	if (!info) {
		throw new Error('余额接口未返回 balance_infos');
	}
	return {
		currency: info.currency ?? 'CNY',
		cashBalance: info.cash_balance ?? '0',
		giftBalance: info.gift_balance ?? '0',
		frozenBalance: info.frozen_balance ?? '0',
		totalAvailable: info.total_available ?? '0',
		isAvailable: body.is_available ?? false,
	};
}

/** PAYG: treat as exhausted when API says unavailable or total_available ≤ 0. */
export function isPaygBalanceExhausted(balance: PaygBalance): boolean {
	const total = Number.parseFloat(balance.totalAvailable);
	const noFunds = Number.isFinite(total) ? total <= 0 : balance.totalAvailable.trim() === '0';
	return !balance.isAvailable || noFunds;
}

async function assetEndpointOk(
	kind: 'payg' | 'token-plan',
	baseUrl: string,
	apiKey: string,
	timeoutMs: number
): Promise<boolean> {
	try {
		if (kind === 'payg') {
			await fetchPaygBalance(baseUrl, apiKey, timeoutMs);
		} else {
			await fetchTokenPlanQuota(baseUrl, apiKey, timeoutMs);
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolve billing plan for UI: Key prefix → Base URL → asset API probe.
 * Prefer Key when it conflicts with Base URL (official keys are not interchangeable).
 */
export async function detectBillingPlan(
	apiKey: string,
	baseUrl: string,
	timeoutMs = 8_000
): Promise<{ plan: KeyPlanHint; source: 'key' | 'baseUrl' | 'probe' | 'unknown'; mismatch?: string }> {
	const keyPlan = resolveBillingPlan({ apiKey });
	const urlPlan = classifyBaseUrl(baseUrl);
	if (keyPlan !== 'unknown') {
		return {
			plan: keyPlan,
			source: 'key',
			mismatch:
				urlPlan !== 'unknown' && urlPlan !== keyPlan
					? 'API Key 与 Base URL 套餐不一致；界面已按 Key 前缀切换。'
					: undefined,
		};
	}
	if (urlPlan !== 'unknown') {
		return { plan: urlPlan, source: 'baseUrl' };
	}

	const probeMs = Math.min(timeoutMs, 8_000);
	const paygBases = [baseUrl, PAYG_BASE_URL].map(normalizeBase);
	const tokenBases = [baseUrl, TOKEN_PLAN_BASE_URL].map(normalizeBase);
	for (const base of [...new Set(paygBases)]) {
		if (await assetEndpointOk('payg', base, apiKey, probeMs)) {
			return { plan: 'payg', source: 'probe' };
		}
	}
	for (const base of [...new Set(tokenBases)]) {
		if (await assetEndpointOk('token-plan', base, apiKey, probeMs)) {
			return { plan: 'token-plan', source: 'probe' };
		}
	}
	return { plan: 'unknown', source: 'unknown' };
}

export async function fetchTokenPlanQuota(
	baseUrl: string,
	apiKey: string,
	timeoutMs = 15_000
): Promise<TokenPlanQuota> {
	const body = await getJson<TokenPlanResponse>(
		`${normalizeBase(baseUrl)}/platform/token_plan`,
		apiKey,
		timeoutMs
	);
	const total = Math.max(0, body.quota?.total_credits ?? 0);
	const used = Math.max(0, body.quota?.used_credits ?? 0);
	const remaining = Math.max(0, body.quota?.remaining_credits ?? Math.max(0, total - used));
	const usedPercent = total > 0 ? Math.min(100, Math.round((used / total) * 1000) / 10) : 0;
	return {
		planCode: body.plan_code ?? '',
		periodStart: body.period?.start_at ?? '',
		periodEnd: body.period?.end_at ?? '',
		totalCredits: total,
		usedCredits: used,
		remainingCredits: remaining,
		autoRenew: body.auto_renew ?? false,
		exhausted: remaining <= 0 && total > 0,
		usedPercent,
	};
}

/** Human-readable reset hint from UTC period end in Beijing time (UTC+8), e.g. `在 08:00 重置 12月1日`. */
export function formatResetHint(periodEndUtc: string): string {
	if (!periodEndUtc) {
		return '重置时间未知';
	}
	const normalized = periodEndUtc.includes('T') ? periodEndUtc : periodEndUtc.replace(' ', 'T') + 'Z';
	const d = new Date(normalized);
	if (Number.isNaN(d.getTime())) {
		return periodEndUtc;
	}
	// Convert to Beijing time (UTC+8)
	const beijingDate = new Date(d.getTime() + 8 * 60 * 60 * 1000);
	const month = beijingDate.getUTCMonth() + 1;
	const day = beijingDate.getUTCDate();
	const hh = String(beijingDate.getUTCHours()).padStart(2, '0');
	const mm = String(beijingDate.getUTCMinutes()).padStart(2, '0');
	return `在 ${hh}:${mm} 重置 ${month}月${day}日`;
}

export const CONSOLE_USAGE = 'https://platform.xiaomimimo.com/#/console/usage';
export const CONSOLE_TOKEN_PLAN = 'https://platform.xiaomimimo.com/#/console/plan-manage';

/** Official daily usage row: https://mimo.mi.com/docs/zh-CN/api/asset/consumption-get */
export interface DailyUsageRecord {
	date: string;
	resource_type?: 'model' | 'plugin' | string;
	name?: string;
	masked_api_key?: string;
	currency?: string;
	consumed_amount?: string;
	request_count?: number;
	input_cache_hit_amount?: string;
	input_cache_miss_amount?: string;
	output_amount?: string;
	total_tokens?: number;
	input_cache_hit_tokens?: number;
	input_cache_miss_tokens?: number;
	output_tokens?: number;
	inference_type?: string;
}

interface DailyUsageListResponse {
	object?: string;
	data?: DailyUsageRecord[];
}

/** PAYG only (`sk-`). UTC natural days, span ≤ 31. */
export async function fetchDailyUsage(
	baseUrl: string,
	apiKey: string,
	startDate: string,
	endDate: string,
	timeoutMs = 20_000
): Promise<DailyUsageRecord[]> {
	const qs = new URLSearchParams({ start_date: startDate, end_date: endDate });
	const body = await getJson<DailyUsageListResponse>(
		`${normalizeBase(baseUrl)}/platform/usage/daily?${qs.toString()}`,
		apiKey,
		timeoutMs
	);
	return Array.isArray(body.data) ? body.data : [];
}
