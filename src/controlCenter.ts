import * as vscode from 'vscode';
import { getApiKey } from './auth';
import {
	buildDebugTurnCards,
	buildSettingsPayload,
	loadBillingPayload,
	type BillingPayload,
	type DebugTurnCard,
	type SettingsPayload,
} from './billingHistory';
import { buildOverviewPayload, type OverviewPayload } from './statusPayload';
import { debugStore } from './debugStore';
import { sessionStats } from './sessionStats';
import { CONSOLE_TOKEN_PLAN, CONSOLE_USAGE } from './platformApi';
import { getCachedBillingPlan, onAccountCacheChange, refreshAccountCache } from './statusHover';
import { openTurnDetail } from './debugTree';
import { getMimoOutput } from './output';

export const CONTROL_CENTER_VIEW_ID = 'xiaomiMimo.controlCenter';
export const FOCUS_CONTROL_CENTER_COMMAND = 'xiaomi-mimo.controlCenter.focus';

function getWebviewNonce(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < 32; i++) {
		out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
	}
	return out;
}

export interface ControlCenterPayload {
	overview: OverviewPayload;
	billing: BillingPayload;
	debugTurns: DebugTurnCard[];
	settings: SettingsPayload;
}

let providerInstance: ControlCenterProvider | undefined;

export function registerControlCenter(
	context: vscode.ExtensionContext,
	opts?: { onExhaustedChange?: (exhausted: boolean) => void }
): void {
	const provider = new ControlCenterProvider(context, opts?.onExhaustedChange);
	providerInstance = provider;

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(CONTROL_CENTER_VIEW_ID, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand(FOCUS_CONTROL_CENTER_COMMAND, async (tab?: string) => {
			await focusControlCenter(typeof tab === 'string' ? tab : undefined);
		}),
		sessionStats.onChange(() => {
			void provider.pushDebugSnapshot();
			if (provider.isVisible()) {
				// Soft refresh only while visible — hidden sidebar must not hit usage APIs every turn.
				void provider.refresh({ forceAccount: false, forceBilling: false });
			} else {
				void provider.pushOverviewLite();
			}
		}),
		debugStore.onDidChange(() => {
			// Debug must not wait on billing/balance network — that regressed empty Debug UI.
			void provider.pushDebugSnapshot();
		}),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('xiaomiMimo')) {
				void provider.refresh({ forceAccount: true, forceBilling: true });
			}
		}),
		vscode.window.onDidChangeActiveColorTheme(() => {
			if (provider.isVisible()) {
				void provider.refresh({ forceAccount: false, forceBilling: false });
			}
		}),
		// Auto UI update when soft/TTL/429-retry refreshes account cache (no manual 刷新).
		onAccountCacheChange(() => {
			if (provider.isVisible()) {
				void provider.refresh({ forceAccount: false, forceBilling: false });
			}
		})
	);
}

export async function focusControlCenter(tab?: string): Promise<void> {
	await vscode.commands.executeCommand(`${CONTROL_CENTER_VIEW_ID}.focus`);
	if (providerInstance) {
		if (tab) {
			providerInstance.selectTab(tab);
		}
		await providerInstance.refresh({ forceAccount: false, forceBilling: false });
	}
}

/** Status bar: open control center, or close the sidebar if it is already visible. */
export async function toggleControlCenter(tab?: string): Promise<void> {
	if (providerInstance?.isVisible()) {
		await vscode.commands.executeCommand('workbench.action.closeSidebar');
		return;
	}
	await focusControlCenter(tab);
}

type WebviewMessage =
	| { type: 'ready' }
	| { type: 'selectTab'; tab: string }
	| { type: 'refresh' }
	| { type: 'openConsole' }
	| { type: 'openSettings' }
	| { type: 'manageKey' }
	| { type: 'clearKey' }
	| { type: 'openDebug' }
	| { type: 'clearDebug' }
	| { type: 'openTurnDetail'; turnId?: string }
	| { type: 'showOutputChannel' };

class ControlCenterProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private visible = false;
	private refreshSeq = 0;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly onExhaustedChange?: (exhausted: boolean) => void
	) {}

	isVisible(): boolean {
		return this.visible && !!this.view?.visible;
	}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	): void {
		this.view = webviewView;
		this.visible = webviewView.visible;
		webviewView.onDidChangeVisibility(() => {
			this.visible = webviewView.visible;
			if (webviewView.visible) {
				void this.refresh({ forceAccount: false, forceBilling: false });
			}
		});
		const { webview } = webviewView;
		webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
		};
		webview.html = this.renderHtml(webview);

		webview.onDidReceiveMessage((msg: WebviewMessage) => {
			void this.handleMessage(msg);
		});

		void this.refresh();
	}

	selectTab(tab: string): void {
		this.view?.webview.postMessage({ type: 'selectTab', tab });
	}

	/** Instant local debug list — never blocked by account/billing HTTP. */
	async pushDebugSnapshot(): Promise<void> {
		const webview = this.view?.webview;
		if (!webview) {
			return;
		}
		try {
			await webview.postMessage({
				type: 'updateDebug',
				debugTurns: buildDebugTurnCards(),
			});
		} catch (err) {
			getMimoOutput().appendLine(`[controlCenter] pushDebugSnapshot failed: ${String(err)}`);
		}
	}

	/** Lightweight overview (session stats only) when sidebar is hidden — no billing HTTP. */
	async pushOverviewLite(): Promise<void> {
		const webview = this.view?.webview;
		if (!webview) {
			return;
		}
		try {
			const iconKind =
				vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ||
				vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight
					? 'light'
					: 'dark';
			const overview = await buildOverviewPayload(this.context, webview, iconKind);
			await webview.postMessage({ type: 'updateOverview', overview });
		} catch (err) {
			getMimoOutput().appendLine(`[controlCenter] pushOverviewLite failed: ${String(err)}`);
		}
	}

	async refresh(opts?: { forceAccount?: boolean; forceBilling?: boolean }): Promise<void> {
		const webview = this.view?.webview;
		if (!webview) {
			return;
		}
		const forceAccount = opts?.forceAccount === true;
		const forceBilling = opts?.forceBilling === true;
		const seq = ++this.refreshSeq;
		try {
			// Always push debug first so UI stays live even if later HTTP fails.
			await this.pushDebugSnapshot();
			if (seq !== this.refreshSeq) {
				return;
			}

			const exhausted = await refreshAccountCache(this.context, forceAccount);
			if (seq !== this.refreshSeq) {
				return;
			}
			this.onExhaustedChange?.(exhausted);

			const cfg = vscode.workspace.getConfiguration('xiaomiMimo');
			const apiKey = await getApiKey(this.context);

			const iconKind =
				vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ||
				vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight
					? 'light'
					: 'dark';
			const [overview, settings, billing] = await Promise.all([
				buildOverviewPayload(this.context, webview, iconKind),
				Promise.resolve(buildSettingsPayload(apiKey, cfg)),
				loadBillingPayload(this.context, { force: forceBilling }),
			]);
			if (seq !== this.refreshSeq) {
				return;
			}

			const payload: ControlCenterPayload = {
				overview,
				billing,
				debugTurns: buildDebugTurnCards(),
				settings,
			};
			await webview.postMessage({ type: 'update', payload });
		} catch (err) {
			getMimoOutput().appendLine(`[controlCenter] refresh failed: ${String(err)}`);
			// Last resort: still try to show whatever debug turns we have.
			await this.pushDebugSnapshot();
		}
	}

	private async handleMessage(msg: WebviewMessage): Promise<void> {
		if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
			return;
		}
		const allowed = new Set([
			'ready',
			'selectTab',
			'refresh',
			'openConsole',
			'openSettings',
			'manageKey',
			'clearKey',
			'openDebug',
			'clearDebug',
			'openTurnDetail',
			'showOutputChannel',
		]);
		if (!allowed.has(msg.type)) {
			return;
		}
		switch (msg.type) {
			case 'ready':
				void this.refresh({ forceAccount: false, forceBilling: false });
				break;
			case 'selectTab': {
				const tab = typeof msg.tab === 'string' ? msg.tab : '';
				if (['overview', 'billing', 'debug', 'settings'].includes(tab)) {
					this.selectTab(tab);
				}
				break;
			}
			case 'refresh':
				void this.refresh({ forceAccount: true, forceBilling: true });
				break;
			case 'openConsole': {
				const plan = getCachedBillingPlan();
				const url = plan === 'token-plan' ? CONSOLE_TOKEN_PLAN : CONSOLE_USAGE;
				await vscode.env.openExternal(vscode.Uri.parse(url));
				break;
			}
			case 'openSettings':
				await vscode.commands.executeCommand('workbench.action.openSettings', 'xiaomiMimo');
				break;
			case 'manageKey':
				await vscode.commands.executeCommand('xiaomi-mimo.manage');
				void this.refresh({ forceAccount: true, forceBilling: true });
				break;
			case 'clearKey':
				await vscode.commands.executeCommand('xiaomi-mimo.clearKey');
				void this.refresh({ forceAccount: true, forceBilling: true });
				break;
			case 'openDebug':
				this.selectTab('debug');
				break;
			case 'clearDebug':
				await vscode.commands.executeCommand('xiaomi-mimo.debug.clear');
				break;
			case 'openTurnDetail': {
				let id = typeof msg.turnId === 'string' ? msg.turnId : undefined;
				if (!id) {
					id = debugStore.list()[0]?.id;
				}
				if (id) {
					await openTurnDetail(id);
				} else {
					void vscode.window.showInformationMessage('尚无 MiMo Debug 记录。');
				}
				break;
			}
			case 'showOutputChannel': {
				const out = getMimoOutput();
				out.appendLine('[controlCenter] Output channel opened.');
				out.show(true);
				break;
			}
			default:
				break;
		}
	}

	private renderHtml(webview: vscode.Webview): string {
		const nonce = getWebviewNonce();
		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} data:`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`script-src 'nonce-${nonce}' ${webview.cspSource}`,
		].join('; ');

		const cssUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'media', 'control-center', 'main.css')
		);
		const jsUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'media', 'control-center', 'main.js')
		);

		return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Xiaomi MiMo 控制中心</title>
  <link rel="stylesheet" href="${cssUri}" />
</head>
<body class="cc-body">
  <div class="sidebar">
    <div class="side-head">
      <span class="side-head-brand">
        <img class="mimo-ico" id="brand-icon" src="" alt="" width="28" height="15" />
        <span>Xiaomi MiMo</span>
      </span>
      <button type="button" class="ghost" id="btn-refresh" title="刷新数据">刷新</button>
    </div>
    <div class="tabs" id="tabs" role="tablist">
      <button type="button" class="active" data-tab="overview" role="tab">概览</button>
      <button type="button" data-tab="billing" role="tab">账单</button>
      <button type="button" data-tab="debug" role="tab">Debug</button>
      <button type="button" data-tab="settings" role="tab">设置</button>
    </div>
    <div class="side-body">
      <div class="panel active" id="panel-overview" role="tabpanel">
        <div class="banner" id="banner-overview">
          <span class="info-dot" aria-hidden="true">i</span>
          <div id="banner-text">余额不足</div>
        </div>
        <div class="payg-only balance">
          <div>
            <div class="label">账户余额</div>
            <div class="hint" id="balance-hint">按量充值余额</div>
          </div>
          <div class="amount" id="balance-amount">…</div>
        </div>
        <div class="token-only">
          <div class="row"><span>额度</span><span id="quota-reset"></span></div>
          <p class="hero" id="quota-hero">…</p>
          <div class="quota-track" aria-label="额度使用">
            <div class="quota-fill" id="quota-fill"></div>
          </div>
          <div class="foot err" id="quota-error" style="display:none;margin-top:8px"></div>
        </div>
        <div class="payg-only">
          <div class="row"><span>本轮费用</span><span id="model-name">—</span></div>
          <p class="hero" id="cost-hero">—</p>
          <div class="bar" aria-hidden="true">
            <i class="a" id="bar-a"></i><i class="b" id="bar-b"></i><i class="c" id="bar-c"></i>
          </div>
          <div class="breakdown" id="breakdown"></div>
        </div>
        <hr class="hr" />
        <div class="section">性能</div>
        <div class="stats">
          <div class="stat"><strong id="stat-speed">—</strong><span>Tokens/s</span></div>
          <div class="stat"><strong id="stat-cache">—</strong><span>Cache</span></div>
          <div class="stat"><strong id="stat-ttft">—</strong><span>First token</span></div>
        </div>
        <div class="section">Token</div>
        <div class="kv">
          <div class="k">Prompt</div><div class="v" id="kv-prompt">—</div>
          <div class="k">Completion</div><div class="v" id="kv-completion">—</div>
          <div class="k">Cached</div><div class="v" id="kv-cached">—</div>
          <div class="k">Uncached</div><div class="v" id="kv-uncached">—</div>
        </div>
        <hr class="hr" />
        <div class="row payg-only"><span id="session-label">本会话累计0轮</span><strong class="emph" id="session-cost">—</strong></div>
        <div class="row token-only"><span>本会话请求</span><strong class="emph" id="session-turns">0 轮</strong></div>
        <div class="foot payg-only err" id="balance-error" style="display:none;margin-top:8px"></div>
        <div class="foot" id="account-freshness" style="display:none;margin-top:8px"></div>
        <div class="foot" id="price-source-wrap" style="margin-top:10px"></div>
        <div class="actions">
          <button type="button" class="primary" id="btn-console" title="打开官方控制台">控制台</button>
        </div>
      </div>

      <div class="panel" id="panel-billing" role="tabpanel">
        <p class="hint" id="billing-source" style="margin-top:0;margin-bottom:10px;line-height:1.45"></p>
        <div class="row" style="margin-bottom:8px">
          <span class="section" style="margin:0">账单及用量</span>
          <span class="pill" id="billing-source-pill">—</span>
        </div>
        <div class="balance" style="margin-bottom:10px">
          <div>
            <div class="label">累计消费</div>
            <div class="hint">基于最近请求估算</div>
          </div>
          <div class="amount" id="bill-total-cost">—</div>
        </div>
        <div class="bill-card">
          <div class="row" style="margin-bottom:8px">
            <strong class="emph">Token 历史消耗</strong>
            <strong class="emph" id="bill-total-tokens">—</strong>
          </div>
          <div class="hint" style="margin-bottom:8px">最近会话聚合</div>
          <div class="kv" style="margin-bottom:0">
            <div class="k"><span class="dot cached"></span>输入 (命中缓存) Token</div><div class="v" id="bill-cached-share">—</div>
            <div class="k"><span class="dot uncached"></span>输入 (未命中缓存) Token</div><div class="v" id="bill-uncached-tok">—</div>
            <div class="k"><span class="dot output"></span>输出 Token</div><div class="v" id="bill-output-tok">—</div>
          </div>
        </div>

        <div class="sec-label" style="font-size:12px;font-weight:600;color:var(--bright);margin:4px 0 6px">消费账单</div>
        <div class="chart-section">
          <div class="sec-head">
            <span id="cost-head-label"><span id="cost-head-title">总体消费金额</span><span class="pipe">|</span><span id="cost-head-sum">—</span></span>
            <div class="seg" id="cost-metric">
              <button type="button" class="active" data-metric="total">总体消费金额</button>
              <button type="button" data-metric="model">模型消费金额</button>
              <button type="button" data-metric="single">单模型消费金额</button>
              <button type="button" data-metric="plugin">插件消费总金额</button>
            </div>
          </div>
          <div class="chart-legend" id="cost-legend"></div>
          <div class="combo-wrap">
            <svg class="combo-chart" id="chart-cost" aria-label="消费账单图表"></svg>
            <div class="chart-tooltip" id="tip-cost"></div>
          </div>
        </div>

        <div class="sec-label" style="font-size:12px;font-weight:600;color:var(--bright);margin:10px 0 6px">用量统计</div>
        <div class="chart-section">
          <div class="sec-head">
            <span id="usage-title">单模型 Token 消耗<span class="pipe">|</span><span id="usage-sum">—</span></span>
            <div class="seg" id="usage-mode">
              <button type="button" data-mode="total">Token 总消耗</button>
              <button type="button" class="active" data-mode="single">单模型 Token 消耗</button>
            </div>
          </div>
          <div class="sec-head" id="usage-model-row" style="justify-content:flex-end;margin-top:6px">
            <div class="fancy-select" id="usage-model">
              <button type="button" class="fancy-select-trigger" id="usage-model-trigger"></button>
              <div class="fancy-select-menu" id="usage-model-menu" role="listbox"></div>
            </div>
          </div>
          <div class="chart-legend" id="usage-legend"></div>
          <div class="combo-wrap">
            <svg class="combo-chart" id="chart-usage" aria-label="用量统计图表"></svg>
            <div class="chart-tooltip" id="tip-usage"></div>
          </div>
        </div>

        <div class="sec-label" style="font-size:12px;font-weight:600;color:var(--bright);margin:10px 0 6px">请求次数</div>
        <div class="chart-section">
          <div class="sec-head"><span>请求次数<span class="pipe">|</span><span id="req-head-sum">—</span></span></div>
          <div class="chart-legend" id="req-legend"></div>
          <div class="combo-wrap">
            <svg class="combo-chart" id="chart-req" aria-label="请求次数图表"></svg>
            <div class="chart-tooltip" id="tip-req"></div>
          </div>
        </div>
      </div>

      <div class="panel" id="panel-debug" role="tabpanel">
        <div class="row" style="align-items:center">
          <span class="section" style="margin:0">最近请求</span>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-left:auto">
            <button type="button" class="ghost" id="btn-clear-debug">清空</button>
            <button type="button" class="ghost" id="btn-output-console">输出通道</button>
          </div>
        </div>
        <div id="debug-turn-list"></div>
      </div>

      <div class="panel" id="panel-settings" role="tabpanel">
        <div class="section">连接</div>
        <div class="kv">
          <div class="k">API Key</div><div class="v"><code id="key-mask">—</code></div>
          <div class="k">Base URL</div><div class="v"><code id="base-url">—</code></div>
        </div>
        <div class="actions" style="justify-content:flex-start">
          <button type="button" id="btn-manage-key">更换 Key</button>
          <button type="button" class="ghost" id="btn-clear-key">清除</button>
        </div>
        <hr class="hr" />
        <div class="section">行为</div>
        <table>
          <tbody>
            <tr><td>Thinking</td><td id="cfg-thinking">—</td></tr>
            <tr><td>Max Completion</td><td id="cfg-max-tok">—</td></tr>
            <tr><td>Web Search</td><td id="cfg-websearch">—</td></tr>
            <tr><td>Currency</td><td id="cfg-currency">—</td></tr>
          </tbody>
        </table>
        <div class="actions">
          <button type="button" id="btn-open-settings">打开设置</button>
        </div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
	}
}
