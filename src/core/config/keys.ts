const KEY_ALIASES: Readonly<Record<string, string>> = {
	reasoning_effort: "reasoningEffort",
	shell_path: "shellPath",
	http_proxy: "httpProxy",
	max_turns: "maxTurns",
	spill_threshold: "spillThreshold",
	stream_idle_timeout_sec: "streamIdleTimeoutSec",
	max_retries: "maxRetries",
	max_delay_ms: "maxDelayMs",
	compact_at: "compactAt",
	keep_recent: "keepRecent",
	summary_timeout_sec: "summaryTimeoutSec",
	compact_model: "compactModel",
	review_model: "reviewModel",
};

/** 递归归一化配置键；snake_case 与 camelCase 并存视为配置错误。 */
export function normalizeConfigKeys(value: unknown, path = ""): unknown {
	if (Array.isArray(value)) return value.map((item, index) => normalizeConfigKeys(item, `${path}[${index}]`));
	if (!value || typeof value !== "object") return value;

	const result: Record<string, unknown> = {};
	const originalByCanonical = new Map<string, string>();
	for (const [key, child] of Object.entries(value)) {
		const canonical = KEY_ALIASES[key] ?? key;
		const previous = originalByCanonical.get(canonical);
		if (previous) {
			const location = path ? `${path}.${canonical}` : canonical;
			throw new Error(`Conflicting config keys at ${location}: ${previous} and ${key}`);
		}
		originalByCanonical.set(canonical, key);
		const nextPath = path ? `${path}.${canonical}` : canonical;
		result[canonical] = normalizeConfigKeys(child, nextPath);
	}
	return result;
}
