import { resolveOverlay } from './models';
import { ApiUsage, formatCacheHitPercent, formatTtft } from './usage';

/** Friendly model title for UI (never raw ids like mimo-v2.6-flash). */
export function friendlyModelName(modelId: string): string {
	return resolveOverlay(modelId).name;
}

export function formatStatusBarText(opts: {
	tokPerSec?: number;
	usage: ApiUsage;
	ttftMs?: number;
	costLabel?: string;
}): string {
	const speed =
		opts.tokPerSec === undefined ? 'Tokens/s N/A' : `${opts.tokPerSec.toFixed(0)} Tokens/s`;
	const hit = formatCacheHitPercent(opts.usage);
	const cache = hit === undefined ? 'Cache N/A' : `Cache ${hit}`;
	const ttft = formatTtft(opts.ttftMs);
	const first = ttft === undefined ? 'First token N/A' : `First token ${ttft}`;
	const cost = opts.costLabel ?? 'Cost N/A';
	return `${speed} · ${cache} · ${first} · ${cost}`;
}

export function formatChatStatusDetail(opts: {
	usage: ApiUsage;
	ttftMs?: number;
	costLabel?: string;
}): string {
	const hit = formatCacheHitPercent(opts.usage);
	const cache = hit === undefined ? 'Cache N/A' : `Cache ${hit}`;
	const ttft = formatTtft(opts.ttftMs);
	const first = ttft === undefined ? 'First token N/A' : `First token ${ttft}`;
	const cost = opts.costLabel ?? 'Cost N/A';
	return `${cache} · ${first} · ${cost}`;
}
