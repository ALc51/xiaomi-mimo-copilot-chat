import * as vscode from 'vscode';
import { toggleControlCenter } from './controlCenter';

export const STATUS_PANEL_COMMAND = 'xiaomi-mimo.status.open';

/** Status bar command → toggle Activity Bar 控制中心（再点一次关闭侧栏）. */
export function registerStatusPanel(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(STATUS_PANEL_COMMAND, async () => {
			await toggleControlCenter('overview');
		})
	);
}
