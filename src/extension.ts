import * as vscode from 'vscode';
import { MimoChatModelProvider, onConfigChanged } from './provider';
import { clearApiKey, getApiKey, promptAndSaveApiKey } from './auth';
import { openMiMoConsole, PerfStatus } from './perfStatus';
import { registerDebugViews } from './debugTree';
import { debugStore } from './debugStore';
import { clearReasoningCache } from './messageConverter';
import { registerStatusHover } from './statusHover';
import { registerControlCenter } from './controlCenter';
import { registerStatusPanel } from './statusPanel';
import { disposeMimoOutput } from './output';
import { disposeBillingHistory } from './billingHistory';

export function activate(context: vscode.ExtensionContext): void {
	const perf = new PerfStatus(context);
	const provider = new MimoChatModelProvider(context, perf);

	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider('xiaomi-mimo', provider),
		{ dispose: () => debugStore.dispose() },
		{ dispose: () => clearReasoningCache() },
		{ dispose: () => disposeBillingHistory() },
		{ dispose: () => disposeMimoOutput() }
	);

	registerStatusPanel(context);
	registerControlCenter(context, {
		onExhaustedChange: (exhausted) => perf.setQuotaExhausted(exhausted),
	});
	registerStatusHover(
		context,
		() => perf.refreshHover(),
		(exhausted) => perf.setQuotaExhausted(exhausted)
	);
	registerDebugViews(context);

	context.subscriptions.push(
		vscode.commands.registerCommand('xiaomi-mimo.manage', async () => {
			await promptAndSaveApiKey(context);
			provider.notifyChanged();
			void vscode.window.showInformationMessage(
				'已保存本扩展专用 API Key。请打开「语言模型」，在 Xiaomi MiMo 下勾选模型后，即可在 Chat 中选择。'
			);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('xiaomi-mimo.clearKey', async () => {
			await clearApiKey(context);
			provider.notifyChanged();
			void vscode.window.showInformationMessage('Xiaomi MiMo API Key 已清除。');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('xiaomi-mimo.refreshModels', () => {
			provider.notifyChanged();
			void vscode.window.showInformationMessage('已刷新 Xiaomi MiMo 模型列表。请到「语言模型」中勾选模型。');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('xiaomi-mimo.status.openConsole', () => openMiMoConsole())
	);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('xiaomiMimo')) {
				onConfigChanged();
				provider.notifyChanged();
				void vscode.commands.executeCommand('xiaomi-mimo.status.refreshHover');
			}
		})
	);

	setTimeout(() => provider.notifyChanged(), 500);

	void (async () => {
		const key = await getApiKey(context);
		if (!key) {
			const pick = await vscode.window.showInformationMessage(
				'Xiaomi MiMo：尚未配置本扩展的 API Key（Custom Endpoint 里的 Key 不会自动共用）。',
				'配置 API Key'
			);
			if (pick === '配置 API Key') {
				await vscode.commands.executeCommand('xiaomi-mimo.manage');
			}
		} else {
			perf.log('API key present; model catalog should appear under vendor Xiaomi MiMo.');
		}
	})();

	perf.log('Xiaomi MiMo For Copilot Chat activated.');
}

export function deactivate(): void {
	clearReasoningCache();
	disposeBillingHistory();
	disposeMimoOutput();
}
