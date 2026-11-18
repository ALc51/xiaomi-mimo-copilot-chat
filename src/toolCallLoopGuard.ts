import * as vscode from 'vscode';

export const DEFAULT_TOOL_LOOP_WARN_AT = 3;
/** Idle gap after which a prior streak is forgotten. */
export const TOOL_LOOP_IDLE_RESET_MS = 10 * 60 * 1000;

export interface ToolLoopAlert {
	name: string;
	argsPreview: string;
	fingerprint: string;
	streak: number;
	threshold: number;
	at: number;
	requestId?: string;
}

export interface ToolLoopRecordResult {
	streak: number;
	fingerprint: string;
	/** True when streak first reaches (or re-hits multiples of) the threshold. */
	shouldAlert: boolean;
	alert: ToolLoopAlert | undefined;
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((v) => stableStringify(v)).join(',')}]`;
	}
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Normalize tool args so key order / whitespace do not break fingerprint equality. */
export function fingerprintToolCall(name: string, args: string | undefined): string {
	const raw = (args ?? '').trim();
	if (!raw) {
		return `${name}\n{}`;
	}
	try {
		return `${name}\n${stableStringify(JSON.parse(raw))}`;
	} catch {
		return `${name}\n${raw}`;
	}
}

export function formatToolLoopAlertMessage(alert: ToolLoopAlert): string {
	const args = alert.argsPreview ? ` args=${alert.argsPreview}` : '';
	return `连续相同 tool call ×${alert.streak}（阈值 ${alert.threshold}）：${alert.name}${args}。请 Stop Agent，或调低 chat.agent.maxRequests / 关闭 Allow all。`;
}

export class ToolCallLoopGuard {
	private lastFingerprint: string | undefined;
	private streak = 0;
	private lastAt = 0;
	private activeAlert: ToolLoopAlert | undefined;
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	getAlert(): ToolLoopAlert | undefined {
		return this.activeAlert;
	}

	getStreak(): number {
		return this.streak;
	}

	clear(): void {
		const had = this.streak > 0 || this.activeAlert !== undefined;
		this.lastFingerprint = undefined;
		this.streak = 0;
		this.lastAt = 0;
		this.activeAlert = undefined;
		if (had) {
			this._onDidChange.fire();
		}
	}

	/** Call when a model turn finishes with no tool_calls — breaks the streak. */
	noteNonToolTurn(now = Date.now()): void {
		this.lastAt = now;
		if (this.streak === 0 && !this.activeAlert) {
			return;
		}
		this.lastFingerprint = undefined;
		this.streak = 0;
		this.activeAlert = undefined;
		this._onDidChange.fire();
	}

	record(opts: {
		name: string;
		arguments?: string;
		threshold: number;
		requestId?: string;
		now?: number;
		argsPreviewMax?: number;
	}): ToolLoopRecordResult {
		const now = opts.now ?? Date.now();
		const threshold = Math.max(0, Math.floor(opts.threshold));
		const fp = fingerprintToolCall(opts.name, opts.arguments);
		const previewMax = opts.argsPreviewMax ?? 160;
		const argsPreview = truncateArgs(opts.arguments ?? '', previewMax);

		if (this.lastAt > 0 && now - this.lastAt > TOOL_LOOP_IDLE_RESET_MS) {
			this.lastFingerprint = undefined;
			this.streak = 0;
			this.activeAlert = undefined;
		}

		if (this.lastFingerprint === fp) {
			this.streak += 1;
		} else {
			this.lastFingerprint = fp;
			this.streak = 1;
			this.activeAlert = undefined;
		}
		this.lastAt = now;

		let shouldAlert = false;
		let alert: ToolLoopAlert | undefined;

		if (threshold > 0 && this.streak >= threshold) {
			alert = {
				name: opts.name,
				argsPreview,
				fingerprint: fp,
				streak: this.streak,
				threshold,
				at: now,
				requestId: opts.requestId,
			};
			shouldAlert = this.streak === threshold || this.streak % threshold === 0;
			this.activeAlert = alert;
		} else if (this.activeAlert && this.streak < threshold) {
			this.activeAlert = undefined;
		}

		this._onDidChange.fire();
		return {
			streak: this.streak,
			fingerprint: fp,
			shouldAlert,
			alert: this.activeAlert,
		};
	}

	dispose(): void {
		this._onDidChange.dispose();
	}
}

function truncateArgs(args: string, max: number): string {
	const oneLine = args.replace(/\s+/g, ' ').trim();
	if (oneLine.length <= max) {
		return oneLine;
	}
	return `${oneLine.slice(0, Math.max(0, max - 1))}…`;
}

export const toolCallLoopGuard = new ToolCallLoopGuard();
