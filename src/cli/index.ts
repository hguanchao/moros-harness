import { resolve } from "node:path";

import { Core, type DiagnosticReport } from "#src/core/index.ts";
import {
	createApprovalBroker,
	createWarningSink,
	runTui,
	type ApprovalBroker,
	type RunTuiOptions,
	type RunTuiResult,
} from "#src/tui/index.ts";
import packageMetadata from "#package.json" with { type: "json" };
import { parseCliArguments } from "#src/cli/arguments.ts";

const HELP_TEXT = `Usage: moros [options] [command]

Commands:
  doctor                 Check local configuration and development tools

Options:
  --session <id|prefix>  Resume a session by full ID or unique prefix
  --resume [id|prefix]   With a value: alias of --session; without: resume the most recent
  --last                 Resume the most recent session in the current project
  --help                 Show this help
  --version              Show the CLI version`;

/** 可替换的 CLI 依赖；业务对象仍在 Core，测试只替换输出与端侧入口。 */
export interface CliDependencies {
	readonly core?: Core;
	readonly approvals?: ApprovalBroker;
	readonly runTui?: (options: RunTuiOptions) => Promise<RunTuiResult>;
	readonly stdout?: (text: string) => void;
	readonly stderr?: (text: string) => void;
}

/**
 * 解析参数并分发命令；不承载会话、审批或工具业务逻辑。
 * @param args 不含可执行文件路径与脚本路径的参数列表。
 * @param deps 可注入的 Core、TUI 入口与输出目标，缺省时使用真实实现。
 * @returns 进程退出码（0 成功，1 配置/命令错误）。
 * @throws 参数无效或命令不可用时抛出英文错误，由入口统一捕获。
 */
export async function runCli(args: readonly string[], deps: CliDependencies = {}): Promise<number> {
	const output =
		deps.stdout ??
		((text: string): void => {
			process.stdout.write(text);
		});
	const warnOutput =
		deps.stderr ??
		((text: string): void => {
			process.stderr.write(text);
		});
	const cli = parseCliArguments(args);
	if (cli.command === "help") {
		output(`${HELP_TEXT}\n`);
		return 0;
	}
	if (cli.command === "version") {
		output(`${packageMetadata.version}\n`);
		return 0;
	}
	if (cli.command === "doctor") {
		// 非全屏命令可以直接把诊断写到 stderr；TUI 分支则由 WarningSink 送进界面
		const core =
			deps.core ??
			new Core({
				onWarning: (message) => {
					warnOutput(`Warning: ${message}\n`);
				},
			});
		const report = await core.doctor(resolve(process.cwd()));
		output(`${formatDoctorReport(report)}\n`);
		return report.errors.length > 0 ? 1 : 0;
	}

	const approvals = deps.approvals ?? createApprovalBroker();
	// 审批决定直接透传给 Core；「allow-session」的会话级放行语义由 Harness 管线实现。
	// 诊断通道必须在构造 Core 时注入：压缩、provider 解析等路径不带本次运行的回调，
	// 缺省会让 Core 走 Node warning 通道，把文本直接写进备用屏。
	const warnings = createWarningSink();
	const core =
		deps.core ??
		new Core({
			requestApproval: (request, signal) => approvals.request(request, signal),
			onWarning: (message) => warnings.emit(message),
		});
	const launch = deps.runTui ?? runTui;
	// --last / 无参 --resume 由 Core 解析成完整 ID：排序规则属于业务逻辑，不放在 CLI。
	let sessionId = cli.sessionId;
	if (cli.lastSession === true) {
		const latest = await core.latestSessionId(resolve(process.cwd()));
		if (latest === undefined) throw new Error("No session to resume in this project");
		sessionId = latest;
	}
	const result = await launch({
		core,
		...(sessionId !== undefined ? { sessionId } : {}),
		approvals,
		warnings,
	});
	// 退出备用屏后提示恢复命令；空会话已被清理时 runTui 不返回 sessionId。
	// 一句定位 + 一条命令足够：前缀恢复与 --last 交给 --help，不在这里堆说明（真实使用反馈）。
	if (result.sessionId !== undefined) {
		output(`Resume this session with:\n  moros --session ${result.sessionId}\n`);
	}
	return 0;
}

function formatDoctorReport(report: DiagnosticReport): string {
	const lines = [
		"Moros Harness diagnostics",
		`Node.js: ${report.nodeVersion}`,
		`Configuration: ${report.configLoaded ? "loaded" : "not loaded"}`,
		"Providers:",
	];
	if (report.providers.length === 0) {
		lines.push("  None configured · add one to ~/.moros/providers.json");
	} else {
		for (const provider of report.providers) {
			const credential = provider.available ? "credential available" : "credential missing";
			lines.push(`  ${provider.name}: ${credential}; ${provider.modelCount} model(s)`);
		}
	}
	lines.push("Environment:");
	for (const [name, tool] of Object.entries(report.environment)) {
		if (!tool.found) {
			lines.push(`  ${name}: unavailable`);
			continue;
		}
		const details = [tool.version, tool.path].filter((value): value is string => value !== undefined);
		lines.push(`  ${name}: ${details.length > 0 ? details.join(" at ") : "available"}`);
	}
	if (report.errors.length > 0) {
		lines.push("Errors:", ...report.errors.map((error) => `  - ${error}`));
	}
	return lines.join("\n");
}
