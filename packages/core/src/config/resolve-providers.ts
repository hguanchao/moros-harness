import type { AppConfig, ProviderConfig, ProvidersFile } from "./schema.ts";
import { resolveSecret } from "./secrets.ts";

export interface ResolvedProvider {
	readonly name: string;
	readonly api: ProviderConfig["api"];
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly timeoutMs: number;
	readonly modelId: string;
	readonly maxTokens: number;
	readonly contextWindow: number;
	readonly reasoning: boolean;
	readonly input: readonly ("text" | "image")[];
}

export interface ProviderResolutionOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly signal?: AbortSignal;
	readonly runCommand?: (command: string, signal?: AbortSignal) => Promise<string>;
}

/**
 * 将激活配置解析为可供 LLM 客户端直接使用的供应商与模型设置。
 * @param config 三层合并并校验后的应用配置。
 * @param providers 供应商注册表。
 * @param options 环境变量、取消信号及可替换的密钥命令执行器。
 * @returns 解析后的供应商配置；未指定供应商/模型时返回 undefined。
 */
export async function resolveActiveProvider(
	config: AppConfig,
	providers: ProvidersFile,
	options: ProviderResolutionOptions = {},
): Promise<ResolvedProvider | undefined> {
	if (!config.provider || !config.model) return undefined;
	const provider = providers.providers[config.provider];
	if (!provider) throw new Error(`Unknown provider configured: ${config.provider}`);
	const model = provider.models.find((candidate) => candidate.id === config.model);
	if (!model) throw new Error(`Unknown model configured: ${config.provider}/${config.model}`);
	const env = options.env ?? process.env;
	const fallbackKey = provider.api === "anthropic-messages" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
	const configuredKey = provider.apiKey || fallbackKey || "";
	// 明文与 ${NAME}、!command 同等合法，选择权在使用者，不做告警或倾向性提示
	const apiKey = configuredKey ? await resolveSecret(configuredKey, { ...options, env }) : "";
	if (!apiKey && !isLocalEndpoint(provider.baseUrl) && !hasCredentialHeader(provider.headers)) {
		throw new Error(`Provider ${config.provider} has no API key configured`);
	}
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(provider.headers ?? {})) {
		headers[name] = await resolveSecret(value, options);
	}
	return {
		name: config.provider,
		api: provider.api,
		baseUrl: provider.baseUrl,
		apiKey,
		headers,
		timeoutMs: provider.timeoutMs,
		modelId: model.id,
		maxTokens: model.maxTokens,
		contextWindow: model.contextWindow ?? 0,
		reasoning: model.reasoning,
		input: model.input,
	};
}

function isLocalEndpoint(baseUrl: string): boolean {
	const hostname = new URL(baseUrl).hostname.toLowerCase();
	return (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname === "127.0.0.1" ||
		hostname === "::1" ||
		hostname === "[::1]"
	);
}

function hasCredentialHeader(headers: Readonly<Record<string, string>> | undefined): boolean {
	return Object.entries(headers ?? {}).some(
		([name, value]) => /authorization|api.?key|token/i.test(name) && value.length > 0,
	);
}
