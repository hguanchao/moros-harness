/** CLI 支持的命令及其解析后参数。 */
export type CliArguments =
	| { readonly command: "help" }
	| { readonly command: "version" }
	| { readonly command: "tui"; readonly sessionId?: string; readonly lastSession?: boolean }
	| { readonly command: "doctor" };

/**
 * 解析命令行参数，不执行命令或触碰 Core 状态。
 * @param args 不含可执行文件路径与脚本路径的参数列表。
 * @returns 可直接交给 CLI 分发入口处理的命令与选项。
 * @throws 遇到未知选项、重复选项、缺少参数或不兼容的选项时抛出英文错误。
 */
export function parseCliArguments(args: readonly string[]): CliArguments {
	if (args.includes("--help")) return { command: "help" };
	if (args.includes("--version")) return { command: "version" };
	let command: "tui" | "doctor" = "tui";
	let commandSpecified = false;
	let sessionId: string | undefined;
	let lastSession = false;
	let sessionOptionSpecified = false;
	const combined = "Options --session/--resume/--last cannot be combined or repeated";

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === undefined) continue;

		if (argument === "--last") {
			if (sessionOptionSpecified) throw new Error(combined);
			sessionOptionSpecified = true;
			lastSession = true;
			continue;
		}

		if (argument === "--session" || argument === "--resume") {
			const value = args[index + 1];
			const hasValue = value !== undefined && !value.startsWith("--") && value.length > 0;
			// 无参 --resume 恢复当前项目最近会话（与 --last 等价）；--session 仍必须带值，
			// 否则拼错的 ID 会被静默当成「恢复最近」，风险太大。
			if (argument === "--resume" && !hasValue) {
				if (sessionOptionSpecified) throw new Error(combined);
				sessionOptionSpecified = true;
				lastSession = true;
				continue;
			}
			if (!hasValue) throw new Error(`Missing value for ${argument}`);
			index += 1;

			if (sessionOptionSpecified) throw new Error(combined);
			sessionOptionSpecified = true;
			sessionId = value;
			continue;
		}

		if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
		if (commandSpecified) throw new Error(`Unexpected argument: ${argument}`);
		if (argument !== "doctor") {
			throw new Error(`Unknown command: ${argument}`);
		}
		command = argument;
		commandSpecified = true;
	}

	if (command === "doctor") {
		if (sessionId !== undefined || lastSession)
			throw new Error("Options --session/--resume/--last can only be used with the TUI");
		return { command };
	}
	return {
		command,
		...(sessionId !== undefined ? { sessionId } : {}),
		...(lastSession ? { lastSession: true } : {}),
	};
}
