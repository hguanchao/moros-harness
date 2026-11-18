/**
 * MCP 的领域类型。
 *
 * 配置形状与 Reins 保持一致：`[mcp_servers.<name>]`，`type` 可省略（有 command 是 stdio，
 * 有 url 是 http）。MCP server 是本程序启动的本地进程或连接的外部端点，项目级
 * `project.toml` 不能新增或替换它们——这条约束在配置装载层执行。
 */

/** MCP server 的接入形态；sse 为旧式传输，当前只解析不连接。 */
export type McpServerType = "stdio" | "http" | "sse";

/** 一个 MCP server 的配置；字段与 Reins 的 `[mcp_servers.<name>]` 对齐。 */
export interface McpServerConfig {
	readonly name: string;
	readonly type: McpServerType;
	/** 仅 stdio 使用。 */
	readonly command: string | undefined;
	readonly args: readonly string[];
	/** 仅 http / sse 使用。 */
	readonly url: string | undefined;
	readonly headers: Readonly<Record<string, string>>;
	/** 叠加在宿主环境之上的变量；值支持 `${ENV}` 与 `!command`。 */
	readonly env: Readonly<Record<string, string>>;
	/** 只作用于 tools/call，单位秒；握手与列工具使用固定短超时。 */
	readonly timeoutSeconds: number | undefined;
	readonly disabled: boolean;
}

/** 连接状态；`unreachable` 是界面识别失败文案的固定值。 */
export type McpConnectionStatus = "connecting" | "connected" | "unreachable" | "disabled";

/** 一个 server 的实时状态，供 `/mcps` 页与启动握手展示。 */
export interface McpStatus {
	readonly name: string;
	readonly status: McpConnectionStatus;
	/** 工具数量、失败原因或 stderr 尾部；没有可说的就是空串。 */
	readonly detail: string;
}

export type McpStatusSource = () => readonly McpStatus[];

/** 运行期管理动作；与 TUI 的 McpControl 结构兼容。 */
export interface McpControl {
	/** 重连一个 server；返回给使用者看的结果说明。 */
	reconnect(name: string): Promise<string>;
	/** 检查全部连接；每个 server 一行结果。 */
	healthCheck(): Promise<readonly string[]>;
	/** 限时等待启动收口；整个进程只等第一次。 */
	awaitStartup(): Promise<void>;
}

/** 远端工具的描述；inputSchema 原样交给模型。 */
export interface McpToolInfo {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
}

/** 一次工具调用的模型可见结果。 */
export interface McpCallResult {
	readonly content: string;
	readonly isError: boolean;
}
