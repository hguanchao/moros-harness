import { z } from "zod";

import type { ConfigSkip } from "../config/schema.ts";
import { resolveSecret, type SecretResolverOptions } from "../config/secrets.ts";
import type { McpServerConfig, McpServerType } from "./types.ts";

/**
 * `config.toml` 里的 MCP server 配置（与 Reins 同形）。
 *
 * 表名 `mcp_servers` / `mcpServers` 由 config/keys.ts 统一成后者；项目级 `project.toml`
 * 的同一张表在装载层被忽略——MCP 决定启动哪个本地进程，只允许用户级配置。
 */

export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const SERVER_TYPES = ["stdio", "http", "sse"] as const satisfies readonly McpServerType[];

/**
 * 设置页写回 config.toml 的 MCP server 草稿（字段名与 TOML 一致）。
 * 校验直接复用 parseMcpServers，避免两处规则漂移。
 */
export interface McpServerDraft {
	readonly type?: "stdio" | "http" | "sse" | undefined;
	readonly command?: string | undefined;
	readonly args?: readonly string[] | undefined;
	readonly url?: string | undefined;
	readonly headers?: Readonly<Record<string, string>> | undefined;
	readonly env?: Readonly<Record<string, string>> | undefined;
	readonly timeout?: number | undefined;
	readonly disabled?: boolean | undefined;
}

/** 校验并规范化一个 server 草稿；非法时抛错（消息可直接展示给使用者）。 */
export function validateMcpServerDraft(name: string, draft: McpServerDraft): McpServerConfig {
	if (!SERVER_NAME_PATTERN.test(name)) {
		throw new Error("server 名称只能包含字母、数字、- 和 _");
	}
	const { servers, skipped } = parseMcpServers({ [name]: draft });
	if (skipped.length > 0 || servers.length !== 1) {
		throw new Error(skipped[0]?.reason ?? "server 配置无效");
	}
	return servers[0]!;
}

const McpServerEntrySchema = z
	.object({
		type: z.enum(SERVER_TYPES).optional(),
		command: z.string().min(1).optional(),
		args: z.array(z.string()).optional(),
		url: z
			.string()
			.url()
			.refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "url must use http or https")
			.optional(),
		headers: z.record(z.string(), z.string()).optional(),
		env: z.record(z.string(), z.string()).optional(),
		timeout: z.number().int().positive().optional(),
		disabled: z.boolean().optional(),
	})
	// 与服务相关的配置是使用者手写的；拼错字段名时整条跳过并报告，避免半套配置被静默采用
	.strict();

/** 首条校验问题的简述；与 providers 注册表的诊断口径一致。 */
function firstIssueReason(error: z.ZodError): string {
	const issue = error.issues[0];
	if (!issue) return "invalid entry";
	const path = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
	return `${issue.message}${path}`;
}

/** 把一个已通过 schema 的条目补齐默认值并推断传输类型。 */
function buildServerConfig(name: string, entry: z.infer<typeof McpServerEntrySchema>): McpServerConfig {
	const type: McpServerType = entry.type ?? (entry.command === undefined ? "http" : "stdio");
	return {
		name,
		type,
		command: entry.command,
		args: entry.args ?? [],
		url: entry.url,
		headers: entry.headers ?? {},
		env: entry.env ?? {},
		timeoutSeconds: entry.timeout,
		disabled: entry.disabled ?? false,
	};
}

/**
 * 解析 `[mcp_servers]` 表，逐条容错。
 *
 * - 名称只允许字母、数字、`-`、`_`；
 * - `type` 可省略，由 command/url 推断；
 * - command 与 url 互斥且必须有一个；
 * - stdio 必须有 command，http/sse 必须有 url；
 * - 字段校验失败只跳过该条目，其余 server 照常加载。
 * @param raw 归一化后的 `mcpServers` 值；undefined 表示没有配置。
 * @returns 通过校验的 server 清单与被跳过条目的诊断。
 */
export function parseMcpServers(raw: unknown): {
	readonly servers: readonly McpServerConfig[];
	readonly skipped: readonly ConfigSkip[];
} {
	if (raw === undefined) return { servers: [], skipped: [] };
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return {
			servers: [],
			skipped: [{ path: "mcp_servers", reason: "expected a table of server entries" }],
		};
	}

	const servers: McpServerConfig[] = [];
	const skipped: ConfigSkip[] = [];
	for (const [name, value] of Object.entries(raw)) {
		const path = `mcp_servers.${name}`;
		if (!SERVER_NAME_PATTERN.test(name)) {
			skipped.push({ path, reason: "server names may only contain letters, digits, - and _" });
			continue;
		}
		const parsed = McpServerEntrySchema.safeParse(value);
		if (!parsed.success) {
			skipped.push({ path, reason: firstIssueReason(parsed.error) });
			continue;
		}
		const entry = parsed.data;
		if (entry.command !== undefined && entry.url !== undefined) {
			skipped.push({ path, reason: "cannot set both command and url" });
			continue;
		}
		if (entry.command === undefined && entry.url === undefined) {
			skipped.push({ path, reason: "needs either command or url" });
			continue;
		}
		const config = buildServerConfig(name, entry);
		if (config.type === "stdio" && config.command === undefined) {
			skipped.push({ path, reason: "a stdio server must set command" });
			continue;
		}
		if (config.type !== "stdio" && config.url === undefined) {
			skipped.push({ path, reason: `a ${config.type} server must set url` });
			continue;
		}
		servers.push(config);
	}
	return { servers, skipped };
}

/**
 * 解析一个 server 的 env / headers 里的 `${ENV}` 与 `!command`。
 *
 * 与 providers.json 的密钥规则共用 `resolveSecret`；缺失变量或命令失败会抛错，由管理器
 * 把该 server 标成不可用，而不是拿半套凭据去连接。
 * @param config 目标 server 配置。
 * @param options 环境变量来源、命令执行器与中止信号（测试可注入）。
 */
export async function resolveMcpEnvironment(
	config: McpServerConfig,
	options: SecretResolverOptions = {},
): Promise<{ readonly env: Record<string, string>; readonly headers: Record<string, string> }> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(config.env)) {
		env[key] = await resolveConfigValue(value, options);
	}
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(config.headers)) {
		headers[key] = await resolveConfigValue(value, options);
	}
	return { env, headers };
}

/**
 * 解析一个 env/header 值。
 *
 * `!command` 必须占满整个值（与 providers.json 的密钥规则一致）；其余情况支持值内嵌
 * `${ENV}`，因为 `Authorization = "Bearer ${TOKEN}"` 是最常见的写法——只匹配整串会让它
 * 原样发出去，错误又很难看出来。
 */
async function resolveConfigValue(value: string, options: SecretResolverOptions): Promise<string> {
	if (value.startsWith("!")) return resolveSecret(value, options);
	const env = options.env ?? process.env;
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
		const resolved = env[name];
		if (resolved === undefined) throw new Error(`Environment variable ${name} is not set`);
		return resolved;
	});
}
