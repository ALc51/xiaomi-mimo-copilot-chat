import * as vscode from 'vscode';
import { friendlyModelName, formatDuration as fmtDuration } from './display';
import { formatCacheHitPercent } from './usage';
import { debugStore, ModelTurn, ModelTurnToolCall } from './debugStore';

function costLabel(turn: ModelTurn): string | undefined {
	return turn.cost?.label;
}

export const MIMO_DEBUG_SCHEME = 'mimo-debug';
export const MIMO_DEBUG_VIEW_ID = 'xiaomiMimo.debug';

type TreeNode =
	| { kind: 'turn'; turn: ModelTurn }
	| { kind: 'meta'; turn: ModelTurn; label: string; detail?: string }
	| { kind: 'tool'; turn: ModelTurn; call: ModelTurnToolCall }
	| { kind: 'empty' };

function formatTokens(n: number | undefined): string {
	if (n === undefined) {
		return 'N/A';
	}
	if (n >= 1000) {
		return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
	}
	return String(n);
}

function formatDuration(ms: number | undefined): string {
	return fmtDuration(ms, 'N/A');
}

function turnLabel(turn: ModelTurn): string {
	const usage = turn.usage;
	const cacheLabel = usage ? (() => {
		const hit = formatCacheHitPercent(usage);
		return hit === undefined ? undefined : `Cache ${hit}`;
	})() : undefined;
	const parts = [
		turn.id,
		friendlyModelName(turn.model),
		turn.status,
		formatDuration(turn.durationMs),
		usage
			? `${formatTokens(usage.prompt_tokens)} in / ${formatTokens(usage.completion_tokens)} out`
			: undefined,
		cacheLabel,
		costLabel(turn),
	].filter(Boolean);
	return parts.join(' · ');
}

function turnIcon(status: ModelTurn['status']): vscode.ThemeIcon {
	switch (status) {
		case 'success':
			return new vscode.ThemeIcon('check');
		case 'failure':
			return new vscode.ThemeIcon('error');
		case 'canceled':
			return new vscode.ThemeIcon('circle-slash');
		default:
			return new vscode.ThemeIcon('loading~spin');
	}
}

export class MimoDebugTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private readonly sub: vscode.Disposable;

	constructor() {
		this.sub = debugStore.onDidChange(() => this._onDidChangeTreeData.fire());
	}

	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		if (element.kind === 'empty') {
			const item = new vscode.TreeItem('尚无请求记录', vscode.TreeItemCollapsibleState.None);
			item.description = '发送一条 MiMo 对话后会出现在这里';
			item.iconPath = new vscode.ThemeIcon('info');
			return item;
		}

		if (element.kind === 'turn') {
			const item = new vscode.TreeItem(turnLabel(element.turn), vscode.TreeItemCollapsibleState.Collapsed);
			item.contextValue = 'mimoDebugTurn';
			item.iconPath = turnIcon(element.turn.status);
			item.tooltip = new vscode.MarkdownString(
				[
					`**${friendlyModelName(element.turn.model)}** \`${element.turn.id}\``,
					`Status: ${element.turn.status}`,
					`Duration: ${formatDuration(element.turn.durationMs)} · First token: ${formatDuration(element.turn.ttftMs)}`,
					element.turn.toolCalls.length
						? `Tools: ${element.turn.toolCalls.map((c) => c.name).join(', ')}`
						: undefined,
					element.turn.error ? `Error: ${element.turn.error}` : undefined,
				]
					.filter(Boolean)
					.join('\n\n')
			);
			item.command = {
				command: 'xiaomi-mimo.debug.openDetail',
				title: 'Open Detail',
				arguments: [element.turn.id],
			};
			return item;
		}

		if (element.kind === 'tool') {
			const item = new vscode.TreeItem(`Tool call ${element.call.name}`, vscode.TreeItemCollapsibleState.None);
			item.description = element.call.id;
			item.iconPath = new vscode.ThemeIcon('tools');
			item.tooltip = element.call.argumentsPreview
				? `id=${element.call.id}\n${element.call.argumentsPreview}`
				: element.call.id;
			return item;
		}

		const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
		item.description = element.detail;
		item.iconPath = new vscode.ThemeIcon('symbol-property');
		return item;
	}

	getChildren(element?: TreeNode): TreeNode[] {
		if (!element) {
			const turns = debugStore.list();
			if (turns.length === 0) {
				return [{ kind: 'empty' }];
			}
			return turns.map((turn) => ({ kind: 'turn', turn }));
		}

		if (element.kind !== 'turn') {
			return [];
		}

		const t = element.turn;
		const children: TreeNode[] = [
			{
				kind: 'meta',
				turn: t,
				label: 'Timing',
				detail: `Duration=${formatDuration(t.durationMs)} First token=${formatDuration(t.ttftMs)}`,
			},
			{
				kind: 'meta',
				turn: t,
				label: 'Request',
				detail: `Messages=${t.messageCount} (${t.messageSummary}) Tools=${t.toolNames.length}`,
			},
		];

		if (t.usage) {
			const hit = formatCacheHitPercent(t.usage);
			children.push({
				kind: 'meta',
				turn: t,
				label: 'Usage',
				detail: `Prompt=${t.usage.prompt_tokens} Completion=${t.usage.completion_tokens} Cached=${t.usage.prompt_tokens_details?.cached_tokens ?? 0}${hit === undefined ? '' : ` Cache=${hit}`}`,
			});
		}

		if (t.cost) {
			children.push({
				kind: 'meta',
				turn: t,
				label: 'Cost',
				detail:
					t.cost.kind === 'payg'
						? `${t.cost.label} · ${t.cost.breakdown}`
						: `${t.cost.label} · ${t.cost.note}`,
			});
		}

		for (const call of t.toolCalls) {
			children.push({ kind: 'tool', turn: t, call });
		}

		if (t.textChars || t.responseTextPreview || t.textChunkCount) {
			children.push({
				kind: 'meta',
				turn: t,
				label: 'Response',
				detail: `${t.textChars} chars · ${t.textChunkCount ?? 0} chunks${t.responseTextPreview ? ` · ${t.responseTextPreview.slice(0, 60)}` : ''}`,
			});
		}

		if (t.thinkingChars || t.thinkingTextPreview) {
			children.push({
				kind: 'meta',
				turn: t,
				label: 'Thinking',
				detail: `${t.thinkingChars} chars`,
			});
		}

		if (t.error) {
			children.push({
				kind: 'meta',
				turn: t,
				label: 'Error',
				detail: t.error,
			});
		}

		return children;
	}

	dispose(): void {
		this.sub.dispose();
		this._onDidChangeTreeData.dispose();
	}
}

function fenceJson(value: unknown): string {
	return '```json\n' + JSON.stringify(value, null, 2) + '\n```';
}

function fenceText(value: string, lang = ''): string {
	const body = value.replace(/\n```/g, '\n``\u200b`');
	return '```' + lang + '\n' + body + '\n```';
}

function renderTurnMarkdown(turn: ModelTurn): string {
	const lines: string[] = [
		`# Model Turn \`${turn.id}\``,
		'',
		'| Field | Value |',
		'| --- | --- |',
		`| Model | **${friendlyModelName(turn.model)}** (\`${turn.model}\`) |`,
		`| Status | **${turn.status}** |`,
		`| Base URL | \`${turn.baseUrl}\` |`,
		`| Created | ${new Date(turn.created).toISOString()} |`,
		`| Duration | ${formatDuration(turn.durationMs)} |`,
		`| First token | ${formatDuration(turn.ttftMs)} |`,
		`| Messages | ${turn.messageCount} (${turn.messageSummary}) |`,
		`| Text | ${turn.textChars} chars · ${turn.textChunkCount ?? 0} chunks |`,
		`| Thinking | ${turn.thinkingChars} chars · ${turn.thinkingChunkCount ?? 0} chunks |`,
		'',
	];

	if (turn.error) {
		lines.push('## Error', '', fenceText(turn.error), '');
	}

	if (turn.usage) {
		const hit = formatCacheHitPercent(turn.usage);
		lines.push(
			'## Usage',
			'',
			'| Metric | Value |',
			'| --- | --- |',
			`| Prompt | ${turn.usage.prompt_tokens} |`,
			`| Completion | ${turn.usage.completion_tokens} |`,
			`| Total | ${turn.usage.total_tokens} |`,
			`| Cached | ${turn.usage.prompt_tokens_details?.cached_tokens ?? 0} |`,
			`| Reasoning | ${turn.usage.completion_tokens_details?.reasoning_tokens ?? 0} |`,
			`| Cache | ${hit ?? 'N/A'} |`,
			'',
			fenceJson(turn.usage),
			''
		);
	}

	if (turn.cost) {
		lines.push('## Cost', '');
		if (turn.cost.kind === 'payg') {
			lines.push(
				'| Field | Value |',
				'| --- | --- |',
				`| Cost | **${turn.cost.label}** |`,
				`| Currency | ${turn.cost.currency} |`,
				`| Breakdown | ${turn.cost.breakdown} |`,
				`| Price source | ${turn.cost.priceSource} |`,
				''
			);
		} else {
			lines.push(`**${turn.cost.label}** — ${turn.cost.note}`, '');
		}
	}

	lines.push('## Request Options', '', fenceJson(turn.requestOptions), '');

	lines.push(
		'## Messages',
		'',
		`Summary: \`${turn.messageSummary}\` · count=${turn.messageCount}`,
		'',
		fenceJson(turn.messagesPreview),
		''
	);

	if (turn.toolNames.length) {
		lines.push(
			'## Tools (request)',
			'',
			turn.toolNames.map((n) => `- \`${n}\``).join('\n'),
			''
		);
	}

	if (turn.toolCalls.length) {
		lines.push('## Tool Calls (response)', '');
		for (const call of turn.toolCalls) {
			lines.push(`### \`${call.name}\``, '', `- id: \`${call.id}\``);
			if (call.argumentsPreview) {
				lines.push('', fenceText(call.argumentsPreview, 'json'));
			}
			lines.push('');
		}
	}

	if (turn.responseTextPreview || turn.textChars) {
		lines.push(
			'## Response',
			'',
			`${turn.textChars} chars · ${turn.textChunkCount ?? 0} chunks`,
			'',
			turn.responseTextPreview ? fenceText(turn.responseTextPreview) : '_empty_',
			''
		);
	}

	if (turn.thinkingTextPreview || turn.thinkingChars) {
		lines.push(
			'## Thinking',
			'',
			`${turn.thinkingChars} chars · ${turn.thinkingChunkCount ?? 0} chunks`,
			'',
			turn.thinkingTextPreview ? fenceText(turn.thinkingTextPreview) : '_empty_',
			''
		);
	}

	lines.push('## Raw', '', fenceJson({
		id: turn.id,
		model: turn.model,
		baseUrl: turn.baseUrl,
		created: new Date(turn.created).toISOString(),
		status: turn.status,
		durationMs: turn.durationMs,
		ttftMs: turn.ttftMs,
		usage: turn.usage,
		cost: turn.cost,
		requestOptions: turn.requestOptions,
		messageCount: turn.messageCount,
		messageSummary: turn.messageSummary,
		messages: turn.messagesPreview,
		tools: turn.toolNames,
		toolCalls: turn.toolCalls,
		responseTextPreview: turn.responseTextPreview,
		thinkingTextPreview: turn.thinkingTextPreview,
		textChars: turn.textChars,
		thinkingChars: turn.thinkingChars,
		textChunkCount: turn.textChunkCount,
		thinkingChunkCount: turn.thinkingChunkCount,
		error: turn.error,
	}));

	return lines.join('\n');
}

export class MimoDebugContentProvider implements vscode.TextDocumentContentProvider {
	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this._onDidChange.event;
	private readonly sub: vscode.Disposable;
	private readonly activeTurnIds = new Set<string>();

	constructor() {
		this.sub = debugStore.onDidChange(() => {
			for (const id of this.activeTurnIds) {
				this._onDidChange.fire(turnDetailUri(id));
			}
		});
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		const id = uri.path.replace(/^\//, '').replace(/\.(md|json)$/, '');
		this.activeTurnIds.add(id);
		const turn = debugStore.get(id);
		if (!turn) {
			this.activeTurnIds.delete(id);
			return `# Turn not found\n\n\`${id}\` is no longer in the debug buffer.`;
		}
		return renderTurnMarkdown(turn);
	}

	dispose(): void {
		this.activeTurnIds.clear();
		this.sub.dispose();
		this._onDidChange.dispose();
	}
}

function turnDetailUri(turnId: string): vscode.Uri {
	return vscode.Uri.from({
		scheme: MIMO_DEBUG_SCHEME,
		path: `/${turnId}.md`,
	});
}

export async function openTurnDetail(turnId: string): Promise<void> {
	const uri = turnDetailUri(turnId);
	await vscode.workspace.openTextDocument(uri);
	// Rendered markdown in the active column (not Beside / ToSide).
	await vscode.commands.executeCommand('markdown.showPreview', uri);
}

export function registerDebugViews(context: vscode.ExtensionContext): void {
	const tree = new MimoDebugTreeProvider();
	const content = new MimoDebugContentProvider();

	context.subscriptions.push(
		tree,
		content,
		vscode.window.registerTreeDataProvider(MIMO_DEBUG_VIEW_ID, tree),
		vscode.workspace.registerTextDocumentContentProvider(MIMO_DEBUG_SCHEME, content),
		vscode.commands.registerCommand('xiaomi-mimo.debug.open', async () => {
			await vscode.commands.executeCommand(`${MIMO_DEBUG_VIEW_ID}.focus`);
		}),
		vscode.commands.registerCommand('xiaomi-mimo.debug.clear', () => {
			debugStore.clear();
		}),
		vscode.commands.registerCommand('xiaomi-mimo.debug.openDetail', async (arg?: unknown) => {
			let turnId: string | undefined;
			if (typeof arg === 'string') {
				turnId = arg;
			} else if (arg && typeof arg === 'object' && 'kind' in arg) {
				const node = arg as TreeNode;
				if (node.kind === 'turn') {
					turnId = node.turn.id;
				} else if (node.kind === 'meta' || node.kind === 'tool') {
					turnId = node.turn.id;
				}
			}
			if (!turnId) {
				turnId = debugStore.list()[0]?.id;
			}
			if (!turnId) {
				void vscode.window.showInformationMessage('尚无 MiMo Debug 记录。');
				return;
			}
			await openTurnDetail(turnId);
		}),
		vscode.commands.registerCommand('xiaomi-mimo.debug.refresh', () => tree.refresh())
	);
}
