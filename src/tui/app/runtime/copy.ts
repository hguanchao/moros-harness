import type { TuiOutput } from "#src/tui/app/options.ts";
import { clearStatusTimer } from "#src/tui/app/runtime/status.ts";
import { STATUS_CLEAR_MS } from "#src/tui/app/runtime/constants.ts";
import { STATUS } from "#src/tui/app/copy/index.ts";
import type { TuiHost } from "#src/tui/app/runtime/types.ts";

/**
 * 复制一段文本。
 *
 * 先交给宿主提供的系统剪贴板；写不进去时退到 OSC 52，让终端自己接住（SSH、容器里没有
 * 剪贴板命令时还有这一条路）。两条都走不通就在状态行说一声，不做落盘之类的补救。
 *
 * 系统剪贴板要起外部进程，Windows 上 PowerShell 启动就要几百毫秒。因此先给一条
 * 「正在复制」的即时反馈，写入结果回来后再订正为「已复制」/「已发给终端」/「失败」，
 * 不让使用者等子进程，也不在动作还没发生时就宣称成功。
 * 提示只占用状态行里 token 计量的位置，超时后自动恢复，不打断当前正在显示的状态文字。
 */
export async function copyText(host: TuiHost, text: string): Promise<void> {
	if (text.trim().length === 0) return;
	showCopyNotice(host, STATUS.copying);

	let copied = false;
	try {
		copied = (await host.options.clipboard?.copy(text)) ?? false;
	} catch {
		copied = false;
	}
	if (copied) {
		showCopyNotice(host, STATUS.copied);
		return;
	}

	if (writeOsc52(host.state.stdout, text)) {
		// OSC 52 只是把序列写进终端，终端是否真的接住无法确认，不能承诺「已复制」
		showCopyNotice(host, STATUS.copySentToTerminal);
		return;
	}

	clearCopyNotice(host);
	host.setStatus(STATUS.copyFailed, "warning");
	host.scheduleStatusClear();
}

/** 状态行右侧的短提示；生命周期由自己的计时器独占，不被上一条状态的清理连坐。 */
function showCopyNotice(host: TuiHost, label: string): void {
	const state = host.state;
	clearStatusTimer(state);
	clearCopyNotice(host);
	state.copyNotice = label;
	state.copyNoticeTimer = setTimeout(() => {
		state.copyNoticeTimer = undefined;
		state.copyNotice = undefined;
		host.render();
	}, STATUS_CLEAR_MS);
	host.render();
}

function clearCopyNotice(host: TuiHost): void {
	const state = host.state;
	if (state.copyNoticeTimer !== undefined) {
		clearTimeout(state.copyNoticeTimer);
		state.copyNoticeTimer = undefined;
	}
	state.copyNotice = undefined;
}

/** OSC 52：把文本直接交给终端写剪贴板；终端不支持时序列会被忽略。 */
function writeOsc52(stdout: TuiOutput, text: string): boolean {
	try {
		stdout.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
		return true;
	} catch {
		return false;
	}
}
