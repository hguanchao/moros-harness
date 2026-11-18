/**
 * 系统剪贴板的写入命令。
 *
 * 文本一律经 stdin 传递，不拼进命令行：Windows 的命令行有长度上限，引号、换行与控制字符
 * 还要逐层转义，任何遗漏都会让复制静默变成空串。旧实现用
 * `[Console]::Out.Write('...') | Set-Clipboard`，更根本的问题是 Console.Out 直接写宿主
 * 控制台流，不产生 PowerShell 管道对象，Set-Clipboard 收到的是空输入；进程却以 0 退出，
 * 界面因此误报「Copied!」。
 */

/** 一次剪贴板写入所需的进程参数与 stdin 内容。 */
export interface ClipboardWrite {
	readonly args: readonly string[];
	readonly input: string;
}

/**
 * Windows PowerShell 的写入命令。
 *
 * `Set-Clipboard -Value` 直接从 stdin 读取全文；`$ErrorActionPreference = 'Stop'` 让写入
 * 失败变成非零退出码，调用方才能退回 OSC 52，而不是把失败当成复制成功。
 *
 * @param text 要写入剪贴板的原文；不做任何转义，原样经 stdin 交给 PowerShell。
 * @returns 传给 `powershell.exe` 的参数列表与 stdin 内容。
 */
export function windowsClipboardWrite(text: string): ClipboardWrite {
	const script = [
		"$ErrorActionPreference = 'Stop'",
		"[Console]::InputEncoding = [System.Text.Encoding]::UTF8",
		"Set-Clipboard -Value ([Console]::In.ReadToEnd())",
	].join("; ");
	return {
		args: ["-NoProfile", "-NonInteractive", "-Command", script],
		input: text,
	};
}
