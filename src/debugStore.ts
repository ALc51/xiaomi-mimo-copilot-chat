import * as vscode from 'vscode';
import type { CostEstimate } from './pricing';
import type { ApiUsage } from './usage';

export type ModelTurnStatus = 'success' | 'failure' | 'canceled' | 'running';

export interface ModelTurnToolCall {
	id: string;
	name: string;
	argumentsPreview?: string;
}

export interface ModelTurn {
	id: string;
	model: string;
	baseUrl: string;
	created: number;
	status: ModelTurnStatus;
	durationMs?: number;
	ttftMs?: number;
	usage?: ApiUsage;
	/** Pay-as-you-go cost from official pricing. */
	cost?: CostEstimate;
	requestOptions: Record<string, unknown>;
	messageCount: number;
	messageSummary: string;
	/** Sanitized / truncated message preview for detail view. */
	messagesPreview: unknown;
	toolNames: string[];
	toolCalls: ModelTurnToolCall[];
	responseTextPreview: string;
	thinkingTextPreview: string;
	textChars: number;
	thinkingChars: number;
	/** How many non-empty text SSE deltas were reported (1 ≈ single blob). */
	textChunkCount?: number;
	thinkingChunkCount?: number;
	error?: string;
}

const DEFAULT_CAPACITY = 100;

export class DebugStore {
	private readonly turns: ModelTurn[] = [];
	private readonly index = new Map<string, ModelTurn>();
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	constructor(private readonly capacity = DEFAULT_CAPACITY) {}

	list(): readonly ModelTurn[] {
		return this.turns;
	}

	get(id: string): ModelTurn | undefined {
		return this.index.get(id);
	}

	upsert(turn: ModelTurn): void {
		const existing = this.index.get(turn.id);
		if (existing) {
			const idx = this.turns.findIndex((t) => t.id === turn.id);
			if (idx >= 0) {
				this.turns[idx] = turn;
			}
			this.index.set(turn.id, turn);
		} else {
			this.turns.unshift(turn);
			this.index.set(turn.id, turn);
			while (this.turns.length > this.capacity) {
				const evicted = this.turns.pop();
				if (evicted) {
					this.index.delete(evicted.id);
				}
			}
		}
		this._onDidChange.fire();
	}

	clear(): void {
		if (this.turns.length === 0) {
			return;
		}
		this.turns.length = 0;
		this.index.clear();
		this._onDidChange.fire();
	}

	dispose(): void {
		this.index.clear();
		this._onDidChange.dispose();
	}
}

export const debugStore = new DebugStore();
