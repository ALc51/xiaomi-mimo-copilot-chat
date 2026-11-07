import * as vscode from 'vscode';

const SECRET_KEY = 'xiaomiMimo.apiKey';

export type KeyPlanHint = 'payg' | 'token-plan' | 'unknown';

export const PAYG_BASE_URL = 'https://api.xiaomimimo.com/v1';
export const TOKEN_PLAN_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1';

export function classifyApiKey(apiKey: string): KeyPlanHint {
	const k = apiKey.trim();
	if (k.startsWith('sk-')) {
		return 'payg';
	}
	if (k.startsWith('tp-') || k.startsWith('ttp-')) {
		return 'token-plan';
	}
	return 'unknown';
}

export function classifyBaseUrl(baseUrl: string): KeyPlanHint {
	const u = baseUrl.toLowerCase();
	if (u.includes('token-plan')) {
		return 'token-plan';
	}
	if (u.includes('xiaomimimo.com') || u.includes('api.xiaomimimo')) {
		return 'payg';
	}
	return 'unknown';
}

/**
 * Local billing-plan resolution for Control Center / status UI.
 * Prefer API Key prefix (official product rule), then Base URL host.
 */
export function resolveBillingPlan(opts: {
	apiKey?: string;
	baseUrl?: string;
}): KeyPlanHint {
	if (opts.apiKey) {
		const keyKind = classifyApiKey(opts.apiKey);
		if (keyKind !== 'unknown') {
			return keyKind;
		}
	}
	if (opts.baseUrl) {
		const urlKind = classifyBaseUrl(opts.baseUrl);
		if (urlKind !== 'unknown') {
			return urlKind;
		}
	}
	return 'unknown';
}

export function planDisplayName(plan: KeyPlanHint): string {
	switch (plan) {
		case 'payg':
			return '按量计费';
		case 'token-plan':
			return 'Token Plan';
		default:
			return '未识别';
	}
}

/** Prefer configured Base URL when it already matches the plan; otherwise use the official default. */
export function assetBaseUrlForPlan(plan: KeyPlanHint, configuredBaseUrl: string): string {
	if (plan === 'token-plan') {
		return classifyBaseUrl(configuredBaseUrl) === 'token-plan'
			? configuredBaseUrl
			: TOKEN_PLAN_BASE_URL;
	}
	if (plan === 'payg') {
		return classifyBaseUrl(configuredBaseUrl) === 'payg' ? configuredBaseUrl : PAYG_BASE_URL;
	}
	return configuredBaseUrl;
}

/** Warn when pay-as-you-go and Token Plan credentials are mixed. */
export function checkKeyBaseUrlConsistency(apiKey: string, baseUrl: string): string | undefined {
	const keyKind = classifyApiKey(apiKey);
	const urlKind = classifyBaseUrl(baseUrl);
	if (keyKind === 'unknown' || urlKind === 'unknown') {
		return undefined;
	}
	if (keyKind !== urlKind) {
		return 'API Key 与 Base URL 可能不属于同一套餐（按量 sk- 与 Token Plan tp-/ttp- 不可混用）。请到控制台核对专属 Base URL。';
	}
	return undefined;
}

export async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
	return context.secrets.get(SECRET_KEY);
}

export async function setApiKey(context: vscode.ExtensionContext, apiKey: string): Promise<void> {
	await context.secrets.store(SECRET_KEY, apiKey.trim());
}

export async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
	await context.secrets.delete(SECRET_KEY);
}

export async function promptAndSaveApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
	const existing = await getApiKey(context);
	const value = await vscode.window.showInputBox({
		title: 'Xiaomi MiMo API Key',
		prompt: '输入 MiMo API Key（按量 sk-… 或 Token Plan tp-/ttp-…）。将安全存储在 SecretStorage。',
		password: true,
		ignoreFocusOut: true,
		value: existing ? '' : undefined,
		placeHolder: existing ? '已保存密钥（留空取消；输入新值则覆盖）' : 'sk-… 或 tp-…',
	});
	if (value === undefined) {
		return existing;
	}
	if (!value.trim()) {
		return existing;
	}
	const baseUrl = vscode.workspace.getConfiguration('xiaomiMimo').get<string>('baseUrl', 'https://api.xiaomimimo.com/v1');
	const warn = checkKeyBaseUrlConsistency(value, baseUrl);
	if (warn) {
		const choice = await vscode.window.showWarningMessage(warn, '仍然保存', '取消');
		if (choice !== '仍然保存') {
			return existing;
		}
	}
	await setApiKey(context, value);
	void vscode.window.showInformationMessage('Xiaomi MiMo API Key 已保存。');
	return value.trim();
}
