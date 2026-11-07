import * as vscode from 'vscode';

/** Single shared Output channel — avoid duplicate "Xiaomi MiMo" entries. */
let channel: vscode.OutputChannel | undefined;

export function getMimoOutput(): vscode.OutputChannel {
	if (!channel) {
		channel = vscode.window.createOutputChannel('Xiaomi MiMo');
	}
	return channel;
}

export function disposeMimoOutput(): void {
	channel?.dispose();
	channel = undefined;
}
