import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isExists } from "../fs-error.ts";

/**
 * 首次运行时的配置骨架。
 *
 * 这是**便利设施，不是启动前置条件**：`loadConfig` 本来就容忍两个文件都不存在。创建它们
 * 只是给使用者一个可见的落点和格式示例，免得第一次打开要猜文件长什么样。因此这里全程
 * best-effort——已存在绝不覆盖，写不进去也不抛，绝不因为初始化失败挡住界面。
 *
 * 不写任何密钥；`apiKey` 留在示例里是空串，真实凭据由使用者自己填或走环境变量。
 */

/** 空注册表；schema 是 strict 的，不能塞注释字段。 */
const PROVIDERS_SKELETON = `{
  "providers": {}
}
`;

const CONFIG_TEMPLATE = `# Moros Harness global configuration
#
# 1. Add a provider to ~/.moros/providers.json, for example:
#
#    {
#      "providers": {
#        "local": {
#          "api": "chat-completions",
#          "baseUrl": "http://localhost:11434/v1",
#          "apiKey": "",
#          "models": [
#            { "id": "qwen2.5", "maxTokens": 8192, "reasoning": false, "input": ["text"] }
#          ]
#        }
#      }
#    }
#
# 2. Uncomment these two lines and use the provider name / model id above.
#
# provider = "local"
# model = "qwen2.5"
#
# approval = "ask"          # ask | auto | yolo
# reasoning_effort = "off"  # off | minimal | low | medium | high | max
#
# Auxiliary models accept "model" or "provider/model", e.g. "qwen2.5" or "local/qwen2.5".
# Both default to the model above.
# compact_model = "qwen2.5"  # context summarization
# review_model = "qwen2.5"   # high-risk review in auto mode
#
# [ui]
# work_step_detail = "standard"   # minimal | standard | detailed | full
# collapse_timing = "afterAnswer" # never | immediately | afterToolCall | afterAnswer
# collapsed_replies = "all"       # all | last | key | none
# code_workspace = true           # show trajectory / diff / agent preset entry
#
# MCP servers live here, in the user-level config only. A project config cannot add
# or replace them: MCP decides which local process starts.
#
# [mcp_servers.filesystem]
# command = "npx"
# args = ["-y", "@modelcontextprotocol/server-filesystem", "."]
# timeout = 60
# disabled = false
#
# [mcp_servers.docs]
# url = "https://example.com/mcp"
# headers = { Authorization = "Bearer \${DOCS_TOKEN}" }
`;

/** 初始化结果：`created` 是本次真正新建的文件；`errors` 是 best-effort 失败的原因。 */
export interface BootstrapResult {
	readonly created: readonly string[];
	readonly errors: readonly string[];
}

/**
 * 幂等地创建 `~/.moros/providers.json` 与 `~/.moros/config.toml`。
 *
 * 用排他写（`wx`）保证并发启动或已有配置时都不覆盖；文件已存在是最常见的正常路径。
 *
 * @param homeDir 用户主目录；配置为 `<homeDir>/.moros/` 下两个文件。
 */
export async function ensureConfigFiles(homeDir: string): Promise<BootstrapResult> {
	const created: string[] = [];
	const errors: string[] = [];
	const dir = join(homeDir, ".moros");
	try {
		await mkdir(dir, { recursive: true });
	} catch (error) {
		// 目录建不了时下面两次写也必然失败，统一在结果里返回，不阻断启动
		return { created, errors: [`Cannot create ${dir}: ${message(error)}`] };
	}

	const files: readonly (readonly [string, string])[] = [
		["providers.json", PROVIDERS_SKELETON],
		["config.toml", CONFIG_TEMPLATE],
	];
	for (const [name, content] of files) {
		const path = join(dir, name);
		try {
			await writeFile(path, content, { flag: "wx", encoding: "utf8" });
			created.push(path);
		} catch (error) {
			if (isExists(error)) continue;
			errors.push(`Cannot create ${path}: ${message(error)}`);
		}
	}
	return { created, errors };
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
