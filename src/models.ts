import * as vscode from 'vscode';

export interface ModelCapabilityOverlay {
	name: string;
	family: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	toolCalling: boolean;
	imageInput: boolean;
	thinking: boolean;
}

/** Context ~1M, output 128K per MiMo docs; leave headroom for output in input budget. */
const DEFAULT_MAX_OUTPUT = 131072;
const DEFAULT_MAX_INPUT = 1_000_000 - DEFAULT_MAX_OUTPUT;

export const FALLBACK_CHAT_MODELS: ModelCapabilityOverlay[] = [
	{
		name: 'MiMo V2.6 Flash',
		family: 'mimo-v2.6',
		maxInputTokens: DEFAULT_MAX_INPUT,
		maxOutputTokens: DEFAULT_MAX_OUTPUT,
		toolCalling: true,
		imageInput: true,
		thinking: true,
	},
	{
		name: 'MiMo V2.6 Pro',
		family: 'mimo-v2.6',
		maxInputTokens: DEFAULT_MAX_INPUT,
		maxOutputTokens: DEFAULT_MAX_OUTPUT,
		toolCalling: true,
		imageInput: true,
		thinking: true,
	},
	{
		name: 'MiMo V2.6 Pro UltraSpeed',
		family: 'mimo-v2.6',
		maxInputTokens: DEFAULT_MAX_INPUT,
		maxOutputTokens: DEFAULT_MAX_OUTPUT,
		toolCalling: true,
		imageInput: true,
		thinking: true,
	},
];

const KNOWN_BY_ID: Record<string, ModelCapabilityOverlay> = {
	'mimo-v2.6-flash': { ...FALLBACK_CHAT_MODELS[0]! },
	'mimo-v2.6-pro': { ...FALLBACK_CHAT_MODELS[1]! },
	'mimo-v2.6-pro-ultraspeed': { ...FALLBACK_CHAT_MODELS[2]! },
};

const NON_CHAT_PATTERN = /(asr|tts|voiceclone|voicedesign|speech)/i;

export function isChatModelId(id: string): boolean {
	return !NON_CHAT_PATTERN.test(id);
}

export function resolveOverlay(id: string, displayName?: string): ModelCapabilityOverlay {
	const known = KNOWN_BY_ID[id];
	if (known) {
		return { ...known, name: displayName || known.name };
	}
	return {
		name: displayName || id,
		family: id.split('-').slice(0, 2).join('-') || 'mimo',
		maxInputTokens: DEFAULT_MAX_INPUT,
		maxOutputTokens: DEFAULT_MAX_OUTPUT,
		toolCalling: true,
		imageInput: true,
		thinking: true,
	};
}

export function toLanguageModelInfo(id: string, overlay: ModelCapabilityOverlay): vscode.LanguageModelChatInformation {
	// isUserSelectable is required on some VS Code builds: if omitted, extension models
	// appear in Language Models editor but are hidden from the Chat model picker.
	//
	// Do NOT set statusIcon: in current VS Code it renders in the Language Models
	// management table (probe: ThemeIcon('robot') appeared there) but does NOT replace
	// the Chat input-bar sparkle, which still uses getModelProviderIcon → Codicon.sparkle
	// for third-party vendors.
	const info = {
		id,
		name: overlay.name,
		family: overlay.family,
		version: '1.0.0',
		maxInputTokens: overlay.maxInputTokens,
		maxOutputTokens: overlay.maxOutputTokens,
		tooltip: `Xiaomi MiMo · ${overlay.name}`,
		detail: 'Xiaomi MiMo API',
		isUserSelectable: true,
		capabilities: {
			toolCalling: overlay.toolCalling,
			imageInput: overlay.imageInput,
			agentMode: overlay.toolCalling,
		},
	};
	return info as vscode.LanguageModelChatInformation;
}

export function fallbackModelInfos(): vscode.LanguageModelChatInformation[] {
	return Object.entries(KNOWN_BY_ID).map(([id, overlay]) => toLanguageModelInfo(id, overlay));
}

interface ModelsListResponse {
	data?: Array<{ id: string; object?: string; owned_by?: string }>;
}

let cache: { at: number; baseUrl: string; models: vscode.LanguageModelChatInformation[] } | undefined;
const CACHE_MS = 60_000;

export function invalidateModelCache(): void {
	cache = undefined;
}

export async function fetchChatModels(
	baseUrl: string,
	apiKey: string,
	timeoutMs: number
): Promise<vscode.LanguageModelChatInformation[]> {
	const normalized = baseUrl.replace(/\/+$/, '');
	if (cache && cache.baseUrl === normalized && Date.now() - cache.at < CACHE_MS) {
		return cache.models;
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${normalized}/models`, {
			method: 'GET',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'api-key': apiKey,
				'Content-Type': 'application/json',
			},
			signal: controller.signal,
		});
		if (!res.ok) {
			throw new Error(`List models failed: HTTP ${res.status}`);
		}
		const body = (await res.json()) as ModelsListResponse;
		const list = (body.data ?? []).map((m) => m.id).filter(isChatModelId);
		const models =
			list.length > 0
				? list.map((id) => toLanguageModelInfo(id, resolveOverlay(id)))
				: fallbackModelInfos();
		cache = { at: Date.now(), baseUrl: normalized, models };
		return models;
	} finally {
		clearTimeout(timer);
	}
}
