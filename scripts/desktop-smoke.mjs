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

	const typography = await page.evaluate(() => {
		const host = document.createElement("div");
		host.style.cssText = "position:fixed;left:-9999px;top:0;visibility:hidden";
		host.innerHTML =
			"<h1>x</h1><h2>x</h2><h3>x</h3><h4>x</h4><h5>x</h5><h6>x</h6><p>x</p><small>x</small><code>x</code><pre>x</pre>";
		document.body.append(host);
		const read = (element) => {
			const style = getComputedStyle(element);
			return { size: Number.parseFloat(style.fontSize), family: style.fontFamily, weight: style.fontWeight };
		};
		const entries = [...host.querySelectorAll("h1,h2,h3,h4,h5,h6,p,small,code,pre")].map((element) => [
			element.tagName.toLowerCase(),
			read(element),
		]);
		host.remove();
		return { entries, body: read(document.body) };
	});
	const fonts = Object.fromEntries(typography.entries);
	const expected = { h1: 24, h2: 20, h3: 18, h4: 17, h5: 16, h6: 15, p: 14, small: 13 };
	for (const [tag, size] of Object.entries(expected)) {
		if (fonts[tag]?.size !== size) throw new Error(`typography ${tag}: expected ${size}px, got ${fonts[tag]?.size}`);
	}
	const levels = ["h1", "h2", "h3", "h4", "h5", "h6", "p", "small"];
	for (let index = 0; index < levels.length - 1; index += 1) {
		const current = fonts[levels[index]];
		const next = fonts[levels[index + 1]];
		if (current.size <= next.size) {
			throw new Error(`typography order: ${levels[index]}=${current.size}px <= ${levels[index + 1]}=${next.size}px`);
		}
	}
	const rootSize = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
	if (rootSize !== 16) throw new Error(`root font-size: expected 16px, got ${rootSize}px`);
	const families = new Set([typography.body.family, ...Object.values(fonts).map((entry) => entry.family)]);
	if (families.size !== 1) throw new Error(`typography has ${families.size} font families`);
	const sidebarType = await page.evaluate(() => {
		const project = document.querySelector(".project-name");
		const session = document.querySelector(".session-title");
		const read = (element) => {
			if (element === null) return undefined;
			const style = getComputedStyle(element);
			return { size: Number.parseFloat(style.fontSize), weight: style.fontWeight, family: style.fontFamily };
		};
		return { project: read(project), session: read(session) };
	});
	if (
		sidebarType.project === undefined ||
		sidebarType.session === undefined ||
		sidebarType.project.size <= sidebarType.session.size
	) {
		throw new Error(`sidebar hierarchy: ${JSON.stringify(sidebarType)}`);
	}
	process.stdout.write(
		`typography: ${Object.entries(fonts)
			.map(([tag, entry]) => `${tag}=${entry.size}px/${entry.weight}`)
			.join(
				", ",
			)}; body=${typography.body.size}px; sidebar project=${sidebarType.project.size}px/${sidebarType.project.weight} > session=${sidebarType.session.size}px/${sidebarType.session.weight}; family unified
`,
	);

	// 侧栏收起/展开：切换按钮应驱动 is-collapsed 类与宽度过渡动画，且最终回到原位
	const readSidebar = () =>
		page.evaluate(() => {
			const sidebar = document.querySelector(".sidebar");
			if (sidebar === null) throw new Error("sidebar is missing");
			const style = getComputedStyle(sidebar);
			return {
				width: sidebar.getBoundingClientRect().width,
				collapsed: sidebar.classList.contains("is-collapsed"),
				transition: style.transitionProperty,
				duration: style.transitionDuration,
			};
		});
	const sidebarOpen = await readSidebar();
	if (sidebarOpen.collapsed || sidebarOpen.width <= 0) {
		throw new Error(`sidebar should start open: ${JSON.stringify(sidebarOpen)}`);
	}
	if (!sidebarOpen.transition.includes("width") || sidebarOpen.duration === "0s") {
		throw new Error(`sidebar width transition missing: ${JSON.stringify(sidebarOpen)}`);
	}
	await page.getByRole("button", { name: "收起侧栏" }).click();
	await page.waitForFunction(() => document.querySelector(".sidebar")?.classList.contains("is-collapsed") === true);
	await page.waitForFunction(() => document.querySelector(".sidebar")?.getBoundingClientRect().width === 0);
	const sidebarCollapsed = await readSidebar();
	if (!sidebarCollapsed.collapsed || sidebarCollapsed.width !== 0) {
		throw new Error(`sidebar did not collapse: ${JSON.stringify(sidebarCollapsed)}`);
	}
	await page.getByRole("button", { name: "展开侧栏" }).click();
	await page.waitForFunction(() => document.querySelector(".sidebar")?.classList.contains("is-collapsed") === false);
	await page.waitForFunction(
		(openWidth) => (document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0) >= openWidth - 1,
		sidebarOpen.width,
	);
	process.stdout.write(`sidebar toggle: ${sidebarOpen.width}px -> 0 -> back, width animated\n`);

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
	try {
		await access(join(project, WRITE_PATH));
	} catch {
		throw new Error("write tool did not create the expected file");
	}

	await page.getByRole("button", { name: "计划", exact: true }).click();
	await page.fill(".composer textarea", "请提交计划");
	await page.click(".send-button");
	await page.waitForSelector(".plan-card", { timeout: 20_000 });
	await page.screenshot({ path: join(shots, "05-plan.png") });
	await page.getByRole("button", { name: "批准并实施" }).click();
	await page.waitForFunction(() => document.body.innerText.includes("计划已实施"), undefined, {
		timeout: 20_000,
	});
	await page.screenshot({ path: join(shots, "06-plan-approved.png") });

	await page.locator('.sidebar-footer button[aria-label="设置"]').click();
	await page.waitForSelector(".settings-app", { timeout: 10_000 });
	await page.screenshot({ path: join(shots, "07-settings.png") });
	const settingsType = await page.evaluate(() => {
		const read = (selector) => {
			const element = document.querySelector(selector);
			if (element === null) return undefined;
			const style = getComputedStyle(element);
			return { size: Number.parseFloat(style.fontSize), weight: style.fontWeight };
		};
		return { pageTitle: read(".settings-page-title"), sectionTitle: read(".settings-section-heading") };
	});
	if (
		settingsType.pageTitle === undefined ||
		settingsType.sectionTitle === undefined ||
		settingsType.pageTitle.size <= settingsType.sectionTitle.size
	) {
		throw new Error(`settings heading hierarchy: ${JSON.stringify(settingsType)}`);
	}
	process.stdout.write(
		`settings headings: h1=${settingsType.pageTitle.size}px > h2=${settingsType.sectionTitle.size}px\n`,
	);

	// 左侧导航：切到供应商分组应渲染真实内容，外观分组的主题/界面字号应真实生效
	await page.getByRole("button", { name: "供应商", exact: true }).click();
	await page.waitForSelector(".provider-card", { timeout: 10_000 });
	await page.getByRole("button", { name: "外观", exact: true }).click();
	await page.waitForSelector(".settings-number input", { timeout: 10_000 });
	const fontSizeInput = page.locator(".settings-number input");
	const readFontSize = () => page.evaluate(() => Number.parseFloat(getComputedStyle(document.body).fontSize));
	if ((await fontSizeInput.inputValue()) !== "14") throw new Error("default ui font size should be 14px");
	await fontSizeInput.fill("16");
	await page.waitForTimeout(300);
	const scaled = await readFontSize();
	if (scaled < 15.5) throw new Error(`ui font size did not scale to 16px, got ${scaled}px`);
	await fontSizeInput.fill("14");
	await page.waitForTimeout(300);
	const restored = await readFontSize();
	if (restored > 14.5) throw new Error(`ui font size did not reset to 14px, got ${restored}px`);
	process.stdout.write(`ui font size: 14px -> ${scaled}px -> ${restored}px\n`);

	// 主题下拉为自绘组件：点击触发按钮后从弹层选择「深色」
	await page.locator(".settings-app .settings-row .dropdown-box .dropdown-trigger").first().click();
	await page.locator('.settings-app .dropdown-option[data-value="dark"]').first().click();
	await page.waitForTimeout(500);
	await page.screenshot({ path: join(shots, "08-theme.png") });

	// 返回工作区：独立视图应能回到聊天页
	await page.getByRole("button", { name: "返回工作区" }).click();
	await page.waitForSelector(".composer textarea", { timeout: 10_000 });
	process.stdout.write("settings: back to workspace ok\n");

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
