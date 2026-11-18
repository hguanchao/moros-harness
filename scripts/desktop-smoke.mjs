/**
 * 桌面端本地冒烟：临时 HOME + 临时项目 + 本地 mock Chat Completions。
 *
 * 覆盖：对话流式、工具调用审批、文件落盘、Diff 页、回滚、文件树、轨迹、会话、设置、主题。
 * 只用于开发机验收，不进入单元测试；运行前先 `npm run desktop:build`。
 * 产物截图写到系统临时目录，退出时打印路径。
 */
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { _electron as electron } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const temp = await mkdtemp(join(tmpdir(), "moros-desktop-smoke-"));
const home = join(temp, "home");
const userData = join(temp, "userData");
const project = join(temp, "project");
const shots = join(temp, "shots");
await mkdir(join(home, ".moros"), { recursive: true });
await mkdir(userData, { recursive: true });
await mkdir(project, { recursive: true });
await mkdir(shots, { recursive: true });
await writeFile(join(project, "README.md"), "# Smoke project\n\nHello from the desktop smoke test.\n", "utf8");
await writeFile(join(project, "AGENTS.md"), "# Smoke instructions\n\nKeep responses short.\n", "utf8");

const WRITE_PATH = "notes/hello.txt";
const WRITE_CONTENT = "created by the desktop smoke test\n";
const shellTool = process.platform === "win32" ? "powershell" : "bash";
const shellCommand =
	process.platform === "win32"
		? "New-Item -ItemType Directory -Force notes | Out-Null; Set-Content -Path notes/shell.txt -Value 'shell wrote this' -NoNewline"
		: "mkdir -p notes && printf 'shell wrote this' > notes/shell.txt";

const server = createServer((request, response) => {
	let body = "";
	request.on("data", (chunk) => {
		body += chunk;
	});
	request.on("end", () => {
		if (!request.url?.endsWith("/chat/completions")) {
			response.writeHead(404).end("not found");
			return;
		}
		let payload = {};
		try {
			payload = JSON.parse(body);
		} catch {
			response.writeHead(400).end("bad json");
			return;
		}
		const messages = Array.isArray(payload.messages) ? payload.messages : [];
		const hasToolResult = messages.some((message) => message.role === "tool");
		const tools = JSON.stringify(payload.tools ?? []);
		const lastUser = [...messages].reverse().find((message) => message.role === "user");
		const lastUserText =
			typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
		const planTool = messages.some(
			(message) => message.role === "tool" && String(message.tool_call_id).startsWith("call_smoke_plan"),
		);
		const mode = lastUserText.startsWith("Implement this plan:")
			? "implemented"
			: planTool
				? "plan-done"
				: tools.includes("present_plan") && lastUserText.includes("请提交计划")
					? "plan"
					: hasToolResult
						? "final"
						: "tool";
		process.stdout.write(`[mock] ${request.method} ${request.url} ${mode}\n`);
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		const stop = (text) => [
			{ choices: [{ index: 0, delta: { role: "assistant", content: text } }] },
			{
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
			},
		];
		const planCall = [
			{
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "call_smoke_plan",
									type: "function",
									function: {
										name: "present_plan",
										arguments: JSON.stringify({
											plan: "# 计划\n\n1. 阅读当前说明文件\n2. 创建 notes/plan.txt\n3. 汇报结果",
										}),
									},
								},
							],
						},
					},
				],
			},
			{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
		];
		const chunks =
			mode === "plan-done"
				? stop("计划已提交，请批准。")
				: mode === "implemented"
					? stop("计划已实施。")
					: mode === "plan"
						? planCall
						: mode === "final"
							? stop("文件已写入，请在变更页查看 Diff。")
							: [
									{
										choices: [
											{
												index: 0,
												delta: {
													role: "assistant",
													tool_calls: [
														{
															index: 0,
															id: "call_smoke_write",
															type: "function",
															function: {
																name: "write",
																arguments: JSON.stringify({ path: WRITE_PATH, content: WRITE_CONTENT }),
															},
														},
														{
															index: 1,
															id: "call_smoke_shell",
															type: "function",
															function: {
																name: shellTool,
																arguments: JSON.stringify({ command: shellCommand }),
															},
														},
													],
												},
											},
										],
									},
									{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
								];
		for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
		response.write("data: [DONE]\n\n");
		response.end();
	});
});

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
if (address === null || typeof address === "string") throw new Error("mock server failed to bind");
const baseUrl = `http://127.0.0.1:${address.port}/v1`;

await writeFile(
	join(home, ".moros", "config.toml"),
	`provider = "mock"\nmodel = "mock-model"\napproval = "ask"\n\n[limits]\nmaxTurns = 8\n`,
	"utf8",
);
await writeFile(
	join(home, ".moros", "providers.json"),
	JSON.stringify(
		{
			providers: {
				mock: {
					api: "chat-completions",
					baseUrl,
					apiKey: "",
					models: [
						{
							id: "mock-model",
							name: "Mock Model",
							maxTokens: 1024,
							contextWindow: 8192,
							reasoning: false,
							input: ["text"],
						},
					],
				},
			},
		},
		null,
		2,
	),
	"utf8",
);

const packaged = process.env.MOROS_SMOKE_EXE;
const app = await electron.launch({
	executablePath: packaged === undefined ? join(root, "node_modules", "electron", "dist", "electron.exe") : packaged,
	args: packaged === undefined ? [root] : [],
	cwd: root,
	env: {
		...process.env,
		MOROS_HOME: home,
		MOROS_DESKTOP_USER_DATA: userData,
		MOROS_DESKTOP_PROJECT: project,
	},
	timeout: 30_000,
});

const errors = [];
try {
	const page = await app.firstWindow({ timeout: 20_000 });
	page.on("console", (message) => {
		if (message.type() === "error" || message.type() === "warning") {
			process.stdout.write(`[renderer:${message.type()}] ${message.text()}\n`);
		}
	});
	page.on("pageerror", (error) => {
		errors.push(error.message);
		process.stdout.write(`[pageerror] ${error.stack ?? error.message}\n`);
	});

	await page.waitForSelector(".composer textarea", { timeout: 20_000 });
	await page.waitForSelector(".trust-card", { timeout: 15_000 });
	await page.screenshot({ path: join(shots, "01-trust.png") });
	await page.getByRole("button", { name: "信任并记住" }).click();
	await page.waitForSelector(".trust-card", { state: "detached", timeout: 10_000 });
	await page.screenshot({ path: join(shots, "02-chat-empty.png") });

	await page.fill(".composer textarea", "写一个说明文件");
	await page.click(".send-button");
	await page.waitForSelector(".approval-card", { timeout: 20_000 });
	await page.screenshot({ path: join(shots, "03-approval.png") });
	await page.getByRole("button", { name: "允许一次" }).click();
	await page.waitForFunction(() => document.body.innerText.includes("文件已写入"), undefined, {
		timeout: 20_000,
	});
	await page.waitForSelector(".file-row", { timeout: 10_000 });
	await page.screenshot({ path: join(shots, "04-chat-tool.png") });

	await page.locator(".side-nav").getByRole("button", { name: "文件", exact: true }).click();
	await page.waitForSelector(".file-tree-pane .tree-row.file", { timeout: 10_000 });
	await page.locator(".tree-row", { hasText: "notes" }).first().click();
	await page.locator(".tree-row.file", { hasText: "hello.txt" }).waitFor({ timeout: 10_000 });
	await page.screenshot({ path: join(shots, "05-files-live.png") });

	await page.locator(".side-nav").getByRole("button", { name: "变更", exact: true }).click();
	await page.waitForSelector(".change-row", { timeout: 10_000 });
	await page.waitForSelector(".diff-hunk", { timeout: 10_000 });
	await page.screenshot({ path: join(shots, "06-changes.png") });
	await page.getByRole("button", { name: "并排", exact: true }).click();
	await page.waitForSelector(".diff-split", { timeout: 10_000 });
	await page.screenshot({ path: join(shots, "07-changes-split.png") });

	page.once("dialog", (dialog) => dialog.accept());
	await page.getByRole("button", { name: /撤销最近一步/ }).click();
	await page.waitForTimeout(800);
	let fileExists = true;
	try {
		await access(join(project, WRITE_PATH));
	} catch {
		fileExists = false;
	}
	if (fileExists) throw new Error("rollback did not remove the written file");

	await page.locator(".side-nav").getByRole("button", { name: "文件", exact: true }).click();
	await page.waitForSelector(".file-tree-pane .tree-row.file", { timeout: 10_000 });
	await page.getByRole("button", { name: /README\.md/ }).click();
	await page.waitForSelector(".code-view", { timeout: 10_000 });
	await page.screenshot({ path: join(shots, "08-files.png") });

	await page.locator(".session-row").first().click();
	await page.waitForSelector(".composer textarea", { timeout: 10_000 });
	await page.getByRole("button", { name: "计划", exact: true }).click();
	await page.fill(".composer textarea", "请提交计划");
	await page.click(".send-button");
	await page.waitForSelector(".plan-card", { timeout: 20_000 });
	await page.screenshot({ path: join(shots, "09-plan.png") });
	await page.getByRole("button", { name: "批准并实施" }).click();
	await page.waitForFunction(() => document.body.innerText.includes("计划已实施"), undefined, {
		timeout: 20_000,
	});
	await page.screenshot({ path: join(shots, "10-plan-approved.png") });

	await page.locator(".side-nav").getByRole("button", { name: "轨迹", exact: true }).click();
	await page.waitForSelector(".trace-turn", { timeout: 10_000 });
	await page.screenshot({ path: join(shots, "11-trace.png") });

	await page.locator(".side-nav").getByRole("button", { name: "会话", exact: true }).click();
	await page.waitForSelector(".session-table-row", { timeout: 10_000 });
	await page.screenshot({ path: join(shots, "12-sessions.png") });

	await page.locator(".side-nav").getByRole("button", { name: "设置", exact: true }).click();
	await page.getByRole("button", { name: "供应商", exact: true }).click();
	await page.waitForSelector(".provider-card", { timeout: 10_000 });
	await page.screenshot({ path: join(shots, "13-settings.png") });

	const themeButton = page.locator(".sidebar-footer button[aria-label^='主题']");
	await themeButton.click();
	await themeButton.click();
	await page.waitForTimeout(400);
	await page.screenshot({ path: join(shots, "14-theme.png") });

	const { Core } = await import("#src/core/index.ts");
	const core = new Core({ homeDir: home });
	try {
		const metas = await core.listSessions(project);
		if (metas.length === 0) throw new Error("Core cannot see the desktop session");
		const events = await core.replay(metas[0].id);
		const hasUser = events.some((event) => event.type === "user.input" && event.payload.text === "写一个说明文件");
		const hasReply = events.some((event) => event.type === "llm.response" && event.payload.text.includes("文件已写入"));
		if (!hasUser || !hasReply) throw new Error("Core replay is missing the desktop conversation");
		process.stdout.write(`core sees ${metas.length} session(s), ${events.length} events\n`);
	} finally {
		await core.dispose();
	}

	process.stdout.write(`smoke ok\nscreenshots: ${shots}\n`);
	if (errors.length > 0) process.exitCode = 1;
} finally {
	await app.close().catch(() => undefined);
	server.close();
	process.stdout.write(`temp: ${temp}\n`);
}
