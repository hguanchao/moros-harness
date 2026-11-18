import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parse as parseToml } from "smol-toml";

import { normalizeConfigKeys } from "#src/core/config/keys.ts";
import {
	parseConfig,
	parseProvidersFile,
	type AppConfig,
	type ConfigSkip,
	type ProvidersFile,
} from "#src/core/config/schema.ts";
import { isMissingPath } from "#src/core/fs-error.ts";

export interface ConfigLoaderOptions {
	homeDir: string;
	projectRoot?: string;
}

export interface LoadedConfig {
	config: AppConfig;
	providers: ProvidersFile;
	/** 逐条容错跳过的坏条目/未知键清单；空数组表示全量通过（ADR-15）。 */
	skipped: readonly ConfigSkip[];
}

/**
 * 「文件不存在」和「文件坏了」是两回事。
 *
 * config.toml 一直用 `readTomlIfExists` 把缺失当成「尚未配置」，providers.json 却会把
 * ENOENT 抛成加载失败，导致首次启动（还没建配置）就在终端打印错误并退出。这里补齐这个
 * 不对称：缺失返回空注册表，损坏（语法错误、权限、路径是目录）仍按原来的错误抛出，
 * doctor 与后续校验才有东西可报。
 */
async function readProvidersFile(path: string): Promise<unknown> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if (isMissingPath(error)) return { providers: {} };
		throw new Error(`Cannot load configuration file ${path}`, { cause: error });
	}
	try {
		return JSON.parse(content);
	} catch (error) {
		throw new Error(`Cannot load configuration file ${path}`, { cause: error });
	}
}

/** 加载 providers 注册表，并按 project > global > defaults 合并 TOML 配置。 */
export async function loadConfig(options: ConfigLoaderOptions): Promise<LoadedConfig> {
	const { providers, skipped: providerSkips } = parseProvidersFile(
		await readProvidersFile(join(options.homeDir, ".moros", "providers.json")),
	);
	const globalConfig = await readTomlIfExists(join(options.homeDir, ".moros", "config.toml"));
	const projectConfig = options.projectRoot
		? await readTomlIfExists(join(options.projectRoot, ".moros", "project.toml"))
		: {};
	const normalizedGlobal = normalizeConfigKeys(globalConfig) as Record<string, unknown>;
	const normalizedProject = normalizeConfigKeys(projectConfig) as Record<string, unknown>;
	// MCP server 只允许用户级配置：项目配置能新增或替换它们，等于让一个目录决定启动哪个
	// 本地进程。与 Reins 同一条约束；项目里写了就忽略并报告，不静默吞掉。
	const globalMcpServers = normalizedGlobal["mcpServers"];
	const projectMcpServers = normalizedProject["mcpServers"];
	delete normalizedGlobal["mcpServers"];
	delete normalizedProject["mcpServers"];
	const merged = deepMerge(normalizedGlobal, normalizedProject);
	const { config, skipped: configSkips } = parseConfig(merged, globalMcpServers);
	const projectMcpSkip =
		projectMcpServers === undefined
			? []
			: [
					{
						path: "mcp_servers",
						reason: "MCP servers are user-level only; a project config cannot add or replace them",
					},
				];
	// 「当前选择」的有效性不在这里校验（ADR-15 真实测试的恢复陷阱）：provider/model 指向
	// 不存在的条目时若在此硬抛，providers.json 里其余可用条目会被一起拖死——目录变空，
	// /model 这个本可自助修复（选择即写回）的入口反而不可用。使用期校验在
	// resolveActiveProvider（发起请求时）与 assertRegisteredModel（写回选择时）。
	return {
		config,
		providers,
		skipped: [...providerSkips, ...configSkips, ...projectMcpSkip],
	};
}

async function readTomlIfExists(path: string): Promise<Record<string, unknown>> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if (isMissingPath(error)) return {};
		throw new Error(`Cannot read configuration file ${path}`, { cause: error });
	}
	try {
		const parsed = parseToml(content);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a table");
		return parsed as Record<string, unknown>;
	} catch (error) {
		throw new Error(`Invalid TOML configuration in ${path}`, { cause: error });
	}
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
	const result = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const previous = result[key];
		result[key] = isRecord(previous) && isRecord(value) ? deepMerge(previous, value) : value;
	}
	return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
