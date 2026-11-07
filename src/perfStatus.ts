import * as vscode from 'vscode';
import { classifyBaseUrl, resolveBillingPlan } from './auth';
import { formatChatStatusDetail, formatStatusBarText } from './display';
import { getMimoOutput } from './output';
import { CONSOLE_TOKEN_PLAN, CONSOLE_USAGE } from './platformApi';
import { buildStatusHoverMarkdown, getCachedBillingPlan } from './statusHover';
import { STATUS_PANEL_COMMAND } from './statusPanel';
import { ApiUsage } from './usage';

export class PerfStatus {
	private statusBar: vscode.StatusBarItem | undefined;
	private chatItem: {
		title: string;
		description: string;
		detail?: string;
		show(): void;
		hide(): void;
		dispose(): void;
	} | undefined;
	private output: vscode.OutputChannel;
	private exhausted = false;
	private lastText = '';

	constructor(private readonly context: vscode.ExtensionContext) {
		this.output = getMimoOutput();
		this.ensureStatusBar();
		this.ensureChatStatus();
	}

	private cfg() {
		return vscode.workspace.getConfiguration('xiaomiMimo');
	}

	private ensureStatusBar(): void {
		if (!this.cfg().get<boolean>('showPerfStatusBar', true)) {
			this.statusBar?.hide();
			return;
		}
		if (!this.statusBar) {
			this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
			this.statusBar.name = 'Xiaomi MiMo';
			this.statusBar.command = STATUS_PANEL_COMMAND;
			this.context.subscriptions.push(this.statusBar);
			this.applyStatusBarAppearance();
			return;
		}
		this.statusBar.show();
	}

	private ensureChatStatus(): void {
		if (!this.cfg().get<boolean>('showPerfInChatStatus', true)) {
			this.chatItem?.hide();
			return;
		}
		if (this.chatItem) {
			return;
		}
		const win = vscode.window as unknown as {
			createChatStatusItem?: (id: string) => {
				title: string;
				description: string;
				detail?: string;
				show(): void;
				hide(): void;
				dispose(): void;
			};
		};
		if (typeof win.createChatStatusItem === 'function') {
			try {
				this.chatItem = win.createChatStatusItem('xiaomi-mimo.perf');
				this.chatItem.title = 'Xiaomi MiMo';
				this.chatItem.description = '就绪';
				this.context.subscriptions.push(this.chatItem);
			} catch {
				this.chatItem = undefined;
			}
		}
	}

	log(line: string): void {
		this.output.appendLine(`[${new Date().toISOString()}] ${line}`);
	}

	refreshHover(): void {
		this.applyStatusBarAppearance();
	}

	setQuotaExhausted(exhausted: boolean): void {
		if (this.exhausted === exhausted) {
			return;
		}
		this.exhausted = exhausted;
		this.applyStatusBarAppearance();
	}

	private applyStatusBarAppearance(): void {
		if (!this.statusBar) {
			return;
		}
		if (this.exhausted) {
			const baseUrl = vscode.workspace
				.getConfiguration('xiaomiMimo')
				.get<string>('baseUrl', 'https://api.xiaomimimo.com/v1');
			const plan =
				getCachedBillingPlan() !== 'unknown'
					? getCachedBillingPlan()
					: resolveBillingPlan({ baseUrl });
			const tokenPlan = plan === 'token-plan';
			const label = tokenPlan ? '已达到配额' : '余额不足';
			this.statusBar.text = `$(xiaomi-mimo) ${label}`;
			this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		} else if (this.lastText) {
			this.statusBar.text = `$(xiaomi-mimo) ${this.lastText}`;
			this.statusBar.backgroundColor = undefined;
		} else {
			this.statusBar.text = '$(xiaomi-mimo)';
			this.statusBar.backgroundColor = undefined;
		}
		this.statusBar.tooltip = buildStatusHoverMarkdown();
		this.statusBar.show();
	}

	update(
		usage: ApiUsage,
		tokPerSec: number | undefined,
		ttftMs?: number,
		costLabel?: string,
		_costDetail?: string
	): void {
		this.ensureStatusBar();
		this.ensureChatStatus();
		this.lastText = formatStatusBarText({ tokPerSec, usage, ttftMs, costLabel });
		const speedLabel =
			tokPerSec === undefined ? 'Tokens/s N/A' : `${tokPerSec.toFixed(0)} Tokens/s`;

		if (this.cfg().get<boolean>('showPerfStatusBar', true) && this.statusBar) {
			this.applyStatusBarAppearance();
		}

		if (this.cfg().get<boolean>('showPerfInChatStatus', true) && this.chatItem) {
			this.chatItem.description = speedLabel;
			this.chatItem.detail = formatChatStatusDetail({ usage, ttftMs, costLabel });
			this.chatItem.show();
		}
	}
}

export async function openMiMoConsole(): Promise<void> {
	const baseUrl = vscode.workspace
		.getConfiguration('xiaomiMimo')
		.get<string>('baseUrl', 'https://api.xiaomimimo.com/v1');
	const plan =
		getCachedBillingPlan() !== 'unknown'
			? getCachedBillingPlan()
			: resolveBillingPlan({ baseUrl }) !== 'unknown'
				? resolveBillingPlan({ baseUrl })
				: classifyBaseUrl(baseUrl);
	const url = plan === 'token-plan' ? CONSOLE_TOKEN_PLAN : CONSOLE_USAGE;
	await vscode.env.openExternal(vscode.Uri.parse(url));
}
