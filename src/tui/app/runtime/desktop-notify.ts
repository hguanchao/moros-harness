import { spawn } from "node:child_process";

/**
 * 系统桌面通知。
 *
 * 留在应用层而不是终端底座：标题是产品名，属于本应用的品牌文案，底座不该替调用方决定
 * 通知长什么样。只是一条旁路提示——没有对应命令时静默忽略，也不能拖住事件循环。
 *
 * @param message 通知正文
 * @param title 通知标题；由调用方从文案模块取
 */
export function desktopNotify(message: string, title: string): void {
	const child =
		process.platform === "darwin"
			? spawn(
					"osascript",
					["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`],
					{ stdio: "ignore", windowsHide: true },
				)
			: spawn("notify-send", [title, message], { stdio: "ignore", windowsHide: true });
	child.on("error", () => {});
	child.unref();
}
