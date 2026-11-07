import { classifyBaseUrl } from './auth';
import type { ApiUsage } from './usage';

/**
 * Official pay-as-you-go rates (per 1M tokens).
 * Source: https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go (updated 2026-10-21).
 * No public pricing API — values are hardcoded and must be revised when docs change.
 */
export type PricingCurrency = 'CNY' | 'USD';

export interface ModelTokenPrices {
	/** Cache-miss input, currency units per 1M tokens. */
	inputPerM: number;
	/** Cache-hit input, currency units per 1M tokens. */
	cacheHitPerM: number;
	/** Output, currency units per 1M tokens. */
	outputPerM: number;
	currency: PricingCurrency;
}

export interface CostPart {
	key: 'uncached' | 'cached' | 'output';
	label: string;
	tokens: number;
	amount: number;
	money: string;
}

export type CostEstimate =
	| {
			kind: 'payg';
			currency: PricingCurrency;
			/** Monetary cost for this turn. */
			amount: number;
			label: string;
			breakdown: string;
			parts: CostPart[];
			priceSource: string;
	  }
	| {
			kind: 'token-plan';
			label: string;
			note: string;
	  }
	| {
			kind: 'unknown';
			label: string;
			note: string;
	  };

export const PRICE_SOURCE = 'mimo.mi.com/docs …/price/pay-as-you-go · 2026-10-21';

const CNY_REALTIME: Record<string, Omit<ModelTokenPrices, 'currency'>> = {
	'mimo-v2.6-flash': { inputPerM: 1, cacheHitPerM: 0.02, outputPerM: 2 },
	'mimo-v2.6-pro': { inputPerM: 3, cacheHitPerM: 0.025, outputPerM: 6 },
	'mimo-v2.6-pro-ultraspeed': { inputPerM: 30, cacheHitPerM: 0.25, outputPerM: 60 },
};

const USD_REALTIME: Record<string, Omit<ModelTokenPrices, 'currency'>> = {
	'mimo-v2.6-flash': { inputPerM: 0.14, cacheHitPerM: 0.0028, outputPerM: 0.28 },
	'mimo-v2.6-pro': { inputPerM: 0.435, cacheHitPerM: 0.0036, outputPerM: 0.87 },
	'mimo-v2.6-pro-ultraspeed': { inputPerM: 4.35, cacheHitPerM: 0.036, outputPerM: 8.7 },
};

function resolveCurrency(baseUrl: string, override?: 'cny' | 'usd' | 'auto'): PricingCurrency {
	if (override === 'cny') {
		return 'CNY';
	}
	if (override === 'usd') {
		return 'USD';
	}
	const u = baseUrl.toLowerCase();
	if (/(global|overseas|intl|-us\.|\/us)/.test(u)) {
		return 'USD';
	}
	return 'CNY';
}

export function lookupModelPrices(
	modelId: string,
	currency: PricingCurrency
): ModelTokenPrices | undefined {
	const table = currency === 'USD' ? USD_REALTIME : CNY_REALTIME;
	const row = table[modelId];
	if (!row) {
		return undefined;
	}
	return { ...row, currency };
}

export function formatMoney(amount: number, currency: PricingCurrency): string {
	const symbol = currency === 'USD' ? '$' : '¥';
	if (amount === 0) {
		return `${symbol}0`;
	}
	if (amount < 0.0001) {
		return `${symbol}${amount.toExponential(2)}`;
	}
	if (amount < 0.01) {
		return `${symbol}${amount.toFixed(4)}`;
	}
	if (amount < 1) {
		return `${symbol}${amount.toFixed(4)}`;
	}
	return `${symbol}${amount.toFixed(2)}`;
}

/** Format API balance strings (already 2 decimals) with currency symbol. */
export function formatBalanceAmount(raw: string, currency: string): string {
	const symbol = currency.toUpperCase() === 'USD' ? '$' : '¥';
	const n = Number(raw);
	if (!Number.isFinite(n)) {
		return `${symbol}${raw}`;
	}
	return `${symbol}${n.toFixed(2)}`;
}

/**
 * Estimate pay-as-you-go cost from reported usage.
 * Cache-hit tokens use cacheHitPerM; remaining prompt tokens use inputPerM.
 * Token Plan / unknown models return a non-monetary label.
 */
export function estimateTurnCost(opts: {
	model: string;
	usage: ApiUsage;
	baseUrl: string;
	/** Settings: auto | cny | usd. Default auto. */
	currencyMode?: 'cny' | 'usd' | 'auto';
}): CostEstimate {
	const plan = classifyBaseUrl(opts.baseUrl);
	if (plan === 'token-plan') {
		return {
			kind: 'token-plan',
			label: 'Token Plan',
			note: 'Token Plan 按套餐额度计费，不按 token 折算人民币。',
		};
	}

	const currency = resolveCurrency(opts.baseUrl, opts.currencyMode ?? 'auto');
	const prices = lookupModelPrices(opts.model, currency);
	if (!prices) {
		return {
			kind: 'unknown',
			label: 'Price N/A',
			note: `未收录模型价目（官网文档）。`,
		};
	}

	const prompt = Math.max(0, opts.usage.prompt_tokens);
	const completion = Math.max(0, opts.usage.completion_tokens);
	const cached = Math.min(prompt, Math.max(0, opts.usage.prompt_tokens_details?.cached_tokens ?? 0));
	const uncached = Math.max(0, prompt - cached);

	const inputCost = (uncached / 1_000_000) * prices.inputPerM;
	const cacheCost = (cached / 1_000_000) * prices.cacheHitPerM;
	const outputCost = (completion / 1_000_000) * prices.outputPerM;
	const amount = inputCost + cacheCost + outputCost;
	const parts: CostPart[] = [
		{
			key: 'uncached',
			label: 'Uncached',
			tokens: uncached,
			amount: inputCost,
			money: formatMoney(inputCost, currency),
		},
		{
			key: 'cached',
			label: 'Cached',
			tokens: cached,
			amount: cacheCost,
			money: formatMoney(cacheCost, currency),
		},
		{
			key: 'output',
			label: 'Output',
			tokens: completion,
			amount: outputCost,
			money: formatMoney(outputCost, currency),
		},
	];

	return {
		kind: 'payg',
		currency,
		amount,
		label: formatMoney(amount, currency),
		breakdown: parts.map((p) => `${p.label} ${p.tokens.toLocaleString('en-US')} → ${p.money}`).join(' · '),
		parts,
		priceSource: PRICE_SOURCE,
	};
}
