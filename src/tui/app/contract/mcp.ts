/** MCP 状态占位类型；当前不提供 MCP，适配器不会注入相关数据源。 */
export interface McpStatus {
	readonly name: string;
	readonly status: string;
	readonly detail: string;
}
export type McpStatusSource = () => readonly McpStatus[];
export interface McpControl {
	reconnect(name: string): Promise<string>;
	healthCheck(): Promise<readonly string[]>;
	awaitStartup(): Promise<void>;
}
