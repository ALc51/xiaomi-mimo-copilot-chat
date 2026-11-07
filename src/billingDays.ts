/**
 * Official `/platform/usage/daily` dates are UTC calendar days.
 * In UTC+8 before 08:00, local "today" is still ahead of UTC today —
 * extend through local today so the chart axis includes the user's date.
 */

export function formatYmd(y: number, monthIndex: number, day: number): string {
	const d = new Date(Date.UTC(y, monthIndex, day));
	return d.toISOString().slice(0, 10);
}

export function shiftYmd(ymd: string, deltaDays: number): string {
	const [ys, ms, ds] = ymd.split('-');
	const y = Number(ys);
	const m = Number(ms);
	const d = Number(ds);
	return formatYmd(y, m - 1, d + deltaDays);
}

export function lastNBillingDays(
	n: number,
	now: Date = new Date()
): { start: string; end: string; days: string[] } {
	const utcToday = formatYmd(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
	const end = localToday > utcToday ? localToday : utcToday;
	const days: string[] = [];
	for (let i = n - 1; i >= 0; i--) {
		days.push(shiftYmd(end, -i));
	}
	return { start: days[0]!, end: days[days.length - 1]!, days };
}

/** Stable short fingerprint for cache keys (avoids last-8 collision). */
export function keyFingerprint(apiKey: string): string {
	let h = 2166136261;
	for (let i = 0; i < apiKey.length; i++) {
		h ^= apiKey.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}
