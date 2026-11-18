/** 会话列表与轨迹里使用的相对时间；超过一周只显示日期。 */
export function relativeTime(iso: string | undefined): string {
	if (iso === undefined) return "";
	const time = Date.parse(iso);
	if (!Number.isFinite(time)) return "";
	const delta = Date.now() - time;
	if (delta < 60_000) return "刚刚";
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
	if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
	if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`;
	return new Date(time).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

export function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return "";
	if (ms < 1_000) return `${Math.round(ms)} ms`;
	if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1_000);
	return `${minutes}m ${seconds}s`;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1_024) return `${bytes} B`;
	if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
	return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

export function fileName(path: string): string {
	const parts = path.split("/");
	return parts.at(-1) ?? path;
}

export function dirName(path: string): string {
	const parts = path.split("/");
	return parts.slice(0, -1).join("/");
}

export function firstLine(text: string, limit = 120): string {
	const line = text.replaceAll(/\s+/g, " ").trim();
	return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
}

/** Windows 事件里的相对路径是反斜杠；界面统一显示为 `/`。 */
export function displayPath(path: string): string {
	return path.replaceAll("\\", "/");
}

export function formatTokens(tokens: number): string {
	if (tokens < 1_000) return `${tokens}`;
	if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}m`;
}
