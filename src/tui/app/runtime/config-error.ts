import { STATUS, configurationUnavailable } from "#src/tui/app/copy/index.ts";
import type { TuiHost } from "#src/tui/app/runtime/types.ts";

/**
 * 配置不可用的操作反馈。
 *
 * 启动阶段是静默的：不打印到终端、也不在对话流顶部预先铺警告，具体原因存在
 * `state.configurationError` 里。真正要用到配置时（提交消息、执行 /model 等命令），才在
 * 状态行给一句短提示，并在对话流留一条带原因的错误行——能回看、能复制，而不是一闪而过。
 *
 * `prompt` 是触发这次操作的那行输入或命令名；保留它才能让「哪次操作没生效」看得出来。
 */
export function reportConfigUnavailable(host: TuiHost, prompt: string): void {
	host.resetStatusMeta();
	host.setStatus(STATUS.configurationInvalid, "notice");
	host.scheduleStatusClear();
	const reason = host.state.configurationError ?? "check config.toml and providers.json";
	host.appendCommandTurn(prompt, [{ kind: "error", text: configurationUnavailable(reason) }]);
}
