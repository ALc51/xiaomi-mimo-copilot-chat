import * as vscode from 'vscode';

export interface ApiUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	prompt_tokens_details?: { cached_tokens?: number };
	completion_tokens_details?: { reasoning_tokens?: number };
}

export function createUsageDataPart(usage: ApiUsage): vscode.LanguageModelDataPart {
	const payload = {
		prompt_tokens: Math.max(0, usage.prompt_tokens),
		completion_tokens: Math.max(0, usage.completion_tokens),
		total_tokens: Math.max(0, usage.total_tokens),
		prompt_tokens_details: {
			cached_tokens: Math.max(0, usage.prompt_tokens_details?.cached_tokens ?? 0),
		},
		completion_tokens_details: {
			reasoning_tokens: Math.max(0, usage.completion_tokens_details?.reasoning_tokens ?? 0),
		},
	};
	const bytes = new TextEncoder().encode(JSON.stringify(payload));
	return new vscode.LanguageModelDataPart(bytes, 'usage');
}

export function cacheHitRate(usage: ApiUsage): number | undefined {
	const cached = usage.prompt_tokens_details?.cached_tokens;
	if (cached === undefined || usage.prompt_tokens <= 0) {
		return undefined;
	}
	return cached / usage.prompt_tokens;
}

/** Percent string with two decimal places, e.g. `96.25%`. */
export function formatCacheHitPercent(usage: ApiUsage): string | undefined {
	const rate = cacheHitRate(usage);
	if (rate === undefined) {
		return undefined;
	}
	return `${(rate * 100).toFixed(2)}%`;
}

export function formatTtft(ms: number | undefined): string | undefined {
	if (ms === undefined) {
		return undefined;
	}
	if (ms >= 1000) {
		return `${(ms / 1000).toFixed(2)}s`;
	}
	return `${ms}ms`;
}

export function formatUsageLog(
	usage: ApiUsage,
	tokPerSec?: number,
	ttftMs?: number,
	costLabel?: string
): string {
	const hit = formatCacheHitPercent(usage);
	const parts = [
		`Prompt=${usage.prompt_tokens}`,
		`Completion=${usage.completion_tokens}`,
		`Total=${usage.total_tokens}`,
		`Reasoning=${usage.completion_tokens_details?.reasoning_tokens ?? 0}`,
		`Cached=${usage.prompt_tokens_details?.cached_tokens ?? 0}`,
		`Cache=${hit ?? 'N/A'}`,
	];
	if (tokPerSec !== undefined) {
		parts.push(`Tokens/s=${tokPerSec.toFixed(1)}`);
	}
	const ttft = formatTtft(ttftMs);
	if (ttft !== undefined) {
		parts.push(`First token=${ttft}`);
	}
	if (costLabel) {
		parts.push(`Cost=${costLabel}`);
	}
	return parts.join(' ');
}
