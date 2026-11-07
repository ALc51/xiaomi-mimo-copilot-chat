import { EventEmitter } from 'events';
import type { CostEstimate } from './pricing';
import { formatMoney } from './pricing';
import type { ApiUsage } from './usage';
import { classifyBaseUrl, type KeyPlanHint } from './auth';

export interface LastTurnSnapshot {
	modelId: string;
	usage: ApiUsage;
	tokPerSec?: number;
	ttftMs?: number;
	cost?: CostEstimate;
	at: number;
}

export interface SessionStatsSnapshot {
	turnCount: number;
	/** Sum of payg turn amounts in the active currency (0 if none). */
	sessionAmount: number;
	sessionCurrency?: 'CNY' | 'USD';
	sessionCostLabel?: string;
	last?: LastTurnSnapshot;
	plan: KeyPlanHint;
	baseUrl: string;
}

class SessionStats extends EventEmitter {
	private turnCount = 0;
	private sessionAmount = 0;
	private sessionCurrency: 'CNY' | 'USD' | undefined;
	private last: LastTurnSnapshot | undefined;
	private baseUrl = 'https://api.xiaomimimo.com/v1';

	recordTurn(opts: {
		modelId: string;
		usage: ApiUsage;
		tokPerSec?: number;
		ttftMs?: number;
		cost?: CostEstimate;
		baseUrl: string;
	}): void {
		this.baseUrl = opts.baseUrl;
		this.turnCount += 1;
		if (opts.cost?.kind === 'payg') {
			if (!this.sessionCurrency) {
				this.sessionCurrency = opts.cost.currency;
			}
			if (this.sessionCurrency === opts.cost.currency) {
				this.sessionAmount += opts.cost.amount;
			}
		}
		this.last = {
			modelId: opts.modelId,
			usage: opts.usage,
			tokPerSec: opts.tokPerSec,
			ttftMs: opts.ttftMs,
			cost: opts.cost,
			at: Date.now(),
		};
		this.emit('change');
	}

	clear(): void {
		this.turnCount = 0;
		this.sessionAmount = 0;
		this.sessionCurrency = undefined;
		this.last = undefined;
		this.emit('change');
	}

	snapshot(): SessionStatsSnapshot {
		const plan =
			this.last?.cost?.kind === 'payg' || this.last?.cost?.kind === 'token-plan'
				? this.last.cost.kind
				: classifyBaseUrl(this.baseUrl);
		return {
			turnCount: this.turnCount,
			sessionAmount: this.sessionAmount,
			sessionCurrency: this.sessionCurrency,
			sessionCostLabel:
				this.sessionCurrency !== undefined && this.sessionAmount > 0
					? formatMoney(this.sessionAmount, this.sessionCurrency)
					: this.sessionCurrency
						? formatMoney(0, this.sessionCurrency)
						: undefined,
			last: this.last,
			plan,
			baseUrl: this.baseUrl,
		};
	}

	onChange(listener: () => void): { dispose(): void } {
		this.on('change', listener);
		return { dispose: () => this.off('change', listener) };
	}
}

export const sessionStats = new SessionStats();
