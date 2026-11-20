import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Core, SessionBusyError, type Session } from "@moros/core";
import { DesktopHost } from "../src/main/core-host.ts";
import { registerIpc } from "../src/main/ipc.ts";
import { DesktopStore } from "../src/main/store.ts";
import {
	IPC,
	type DesktopBridge,
	type PushMessage,
	type RpcResult,
	type SessionCreateInput,
} from "../src/shared/contract.ts";

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<RpcResult<unknown>>;

const electronMock = vi.hoisted(() => {
	const handlers = new Map<string, IpcHandler>();
	return {
		handlers,
		showOpenDialog: vi.fn(),
		showSaveDialog: vi.fn(),
		invoke: vi.fn(),
		expose: vi.fn(),
		handle: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
	};
});

vi.mock("electron", () => ({
	dialog: { showOpenDialog: electronMock.showOpenDialog, showSaveDialog: electronMock.showSaveDialog },
	Notification: { isSupported: () => false },
	shell: { beep: vi.fn(), openExternal: vi.fn() },
	ipcMain: { handle: electronMock.handle },
	contextBridge: { exposeInMainWorld: electronMock.expose },
	ipcRenderer: { invoke: electronMock.invoke, on: vi.fn(), removeListener: vi.fn() },
}));

interface HostFixture {
	readonly directory: string;
	readonly homeDir: string;
	readonly userDataDir: string;
	readonly core: Core;
}

const directories: string[] = [];
const hosts: DesktopHost[] = [];
const cores: Core[] = [];
const IMAGE_BYTES = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
const RUN_RESULT: Awaited<ReturnType<Core["runSession"]>> = { messages: [], turns: 1, paused: false };

async function fixture(): Promise<HostFixture> {
	const directory = await mkdtemp(join(tmpdir(), "moros-desktop-host-"));
	directories.push(directory);
	const homeDir = join(directory, "home");
	const userDataDir = join(directory, "desktop");
	await mkdir(homeDir);
	await mkdir(userDataDir);
	let timestamp = Date.UTC(2020, 0, 1);
	const core = new Core({ homeDir, now: () => new Date((timestamp += 1_000)) });
	cores.push(core);
	return { directory, homeDir, userDataDir, core };
}

async function openHost(input: HostFixture): Promise<{ host: DesktopHost; messages: PushMessage[] }> {
	const messages: PushMessage[] = [];
	const host = await DesktopHost.create({
		userDataDir: input.userDataDir,
		homeDir: input.homeDir,
		getWindow: () => undefined,
		push: (message) => messages.push(message),
	});
	hosts.push(host);
	return { host, messages };
}

async function projectDirectory(input: HostFixture, name: string): Promise<string> {
	const directory = join(input.directory, name);
	await mkdir(directory);
	return realpath(directory);
}

async function savedSession(core: Core, root: string, title: string): Promise<Session> {
	const session = await core.createSession(root, { title });
	await session.append({ type: "user.input", payload: { text: title } });
	return session;
}

function ipcClient(host: DesktopHost): {
	request: (channel: string, ...args: unknown[]) => Promise<RpcResult<unknown>>;
	event: IpcMainInvokeEvent;
} {
	// 仅模拟发送方校验所需的 Electron 表面，不启动窗口或 Electron 进程。
	const mainFrame = {};
	const webContents = { id: 7, mainFrame };
	const window = { webContents, isDestroyed: () => false } as unknown as BrowserWindow;
	const event = { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
	registerIpc(host, () => window);
	return {
		event,
		request: (channel, ...args) => {
			const handler = electronMock.handlers.get(channel);
			if (handler === undefined) throw new Error(`Missing IPC handler: ${channel}`);
			return handler(event, ...args);
		},
	};
}

beforeEach(() => {
	electronMock.handlers.clear();
	electronMock.handle.mockClear();
	electronMock.showOpenDialog.mockReset().mockResolvedValue({ canceled: true, filePaths: [] });
	electronMock.showSaveDialog.mockReset().mockResolvedValue({ canceled: true });
	electronMock.invoke.mockReset().mockResolvedValue({ ok: true, value: null });
	electronMock.expose.mockClear();
});

afterEach(async () => {
	await Promise.all(hosts.splice(0).map((host) => host.dispose()));
	await Promise.all(cores.splice(0).map((core) => core.dispose()));
	vi.restoreAllMocks();
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("DesktopHost initialization", () => {
	it("首次无历史默认 tasks，无会话且不弹 picker，settings/models 可读取", async () => {
		const input = await fixture();
		const { host } = await openHost(input);
		const create = vi.spyOn(Core.prototype, "createSession");
		const snapshot = await host.initialize();

		expect(snapshot.taskRoot).toBe(await realpath(join(input.userDataDir, "tasks-workspace")));
		expect(snapshot.project).toMatchObject({ root: snapshot.taskRoot, target: { kind: "tasks" }, recentProjects: [] });
		expect(snapshot.project?.session).toBeUndefined();
		expect(snapshot.recentProjects).toEqual([]);
		expect(electronMock.showOpenDialog).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
		expect((await host.settings()).config.approval).toBe("ask");
		expect(await host.models()).toEqual({ providers: [] });
		expect((await host.configSummary()).providers).toEqual([]);
		expect(await input.core.listSessions()).toEqual([]);
		await expect(access(join(snapshot.taskRoot, ".moros"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("恢复最近真实项目最新活动未归档会话，而不是最新创建或归档会话", async () => {
		const input = await fixture();
		const root = await projectDirectory(input, "project");
		const older = await savedSession(input.core, root, "older");
		await savedSession(input.core, root, "newer");
		const archived = await savedSession(input.core, root, "archived");
		await input.core.archiveSession(archived, true);
		await older.append({ type: "user.input", payload: { text: "most recent activity" } });
		await (await DesktopStore.open(input.userDataDir)).rememberProject(root);
		const { host } = await openHost(input);
		const create = vi.spyOn(Core.prototype, "createSession");

		const snapshot = await host.initialize();

		expect(snapshot.project?.target).toEqual({ kind: "project", root });
		expect(snapshot.project?.session?.meta.id).toBe(older.meta.id);
		expect(snapshot.project?.session?.readOnly).toBe(false);
		expect(create).not.toHaveBeenCalled();
		expect(electronMock.showOpenDialog).not.toHaveBeenCalled();
		await host.dispose();
		await input.core.acquireSessionLease(older);
		await input.core.releaseSessionLease(older.meta.id);
	});

	it.each([false, true])("最近项目无可恢复会话（全归档=%s）时不补建", async (hasArchived) => {
		const input = await fixture();
		const root = await projectDirectory(input, "project");
		if (hasArchived) {
			const session = await savedSession(input.core, root, "archived");
			await input.core.archiveSession(session, true);
		}
		await (await DesktopStore.open(input.userDataDir)).rememberProject(root);
		const { host } = await openHost(input);
		const create = vi.spyOn(Core.prototype, "createSession");

		const snapshot = await host.initialize();

		expect(snapshot.project?.root).toBe(root);
		expect(snapshot.project?.session).toBeUndefined();
		expect(create).not.toHaveBeenCalled();
		expect((await host.listSessions({ includeArchived: true })).items).toHaveLength(hasArchived ? 1 : 0);
	});

	it("恢复快照失败释放半初始化 Core/租约，回到 tasks 无会话", async () => {
		const input = await fixture();
		const root = await projectDirectory(input, "project");
		const session = await savedSession(input.core, root, "saved");
		await (await DesktopStore.open(input.userDataDir)).rememberProject(root);
		const { host, messages } = await openHost(input);
		vi.spyOn(Core.prototype, "getSessionMetrics").mockRejectedValueOnce(new Error("metrics unavailable"));
		const dispose = vi.spyOn(Core.prototype, "dispose");

		const snapshot = await host.initialize();

		expect(snapshot.project?.target).toEqual({ kind: "tasks" });
		expect(snapshot.project?.root).toBe(snapshot.taskRoot);
		expect(snapshot.project?.session).toBeUndefined();
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(messages).toContainEqual(expect.objectContaining({ type: "notice", level: "warn" }));
		await input.core.acquireSessionLease(session);
		await input.core.releaseSessionLease(session.meta.id);
	});

	it("最近目录已不存在时安全回到 tasks，不弹 picker", async () => {
		const input = await fixture();
		await (await DesktopStore.open(input.userDataDir)).rememberProject(join(input.directory, "missing"));
		const { host } = await openHost(input);

		const snapshot = await host.initialize();

		expect(snapshot.project?.target).toEqual({ kind: "tasks" });
		expect(snapshot.project?.session).toBeUndefined();
		expect(electronMock.showOpenDialog).not.toHaveBeenCalled();
	});

	it("历史任务根从最近项目排除，启动仍保持空 tasks 草稿", async () => {
		const input = await fixture();
		const { host: first } = await openHost(input);
		const firstSnapshot = await first.initialize();
		await first.dispose();
		await savedSession(input.core, firstSnapshot.taskRoot, "task history");
		await (await DesktopStore.open(input.userDataDir)).rememberProject(firstSnapshot.taskRoot);
		const { host } = await openHost(input);

		const snapshot = await host.initialize();

		expect(snapshot.recentProjects).toEqual([]);
		expect(snapshot.project?.recentProjects).toEqual([]);
		expect(snapshot.project?.session).toBeUndefined();
		expect((await host.listSessions({ target: { kind: "tasks" } })).items).toHaveLength(1);
	});

	it("默认任务目录为文件时创建宿主失败，不回退其他根", async () => {
		const input = await fixture();
		const path = join(input.userDataDir, "tasks-workspace");
		await writeFile(path, "keep me");

		await expect(openHost(input)).rejects.toMatchObject({ code: "task-workspace-error" });
		expect(await readFile(path, "utf8")).toBe("keep me");
		expect(await input.core.listSessions()).toEqual([]);
	});
});

describe("DesktopHost project selection", () => {
	it("选择仅登记项目；刷新 appState 也不会打开选择目标或恢复其历史", async () => {
		const input = await fixture();
		const root = await projectDirectory(input, "selected");
		await savedSession(input.core, root, "existing history");
		const { host } = await openHost(input);
		const before = await host.initialize();
		const open = vi.spyOn(Core.prototype, "openSession");
		const lease = vi.spyOn(Core.prototype, "acquireSessionLease");
		electronMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [root] });

		const selection = await host.selectProjectDialog();
		const after = await host.initialize();

		expect(selection?.project).toEqual({ root, name: "selected" });
		expect(selection?.recentProjects.map((project) => project.root)).toEqual([root]);
		expect(after.project?.root).toBe(before.taskRoot);
		expect(after.project?.session).toBeUndefined();
		expect(open).not.toHaveBeenCalled();
		expect(lease).not.toHaveBeenCalled();
	});

	it("所有项目 picker 取消都返回 null 且不改变工作区/最近项目/目录", async () => {
		const input = await fixture();
		const { host } = await openHost(input);
		const before = await host.initialize();

		expect(await host.selectProjectDialog()).toBeNull();
		expect(await host.createProjectDialog("not-created")).toBeNull();
		expect(await host.openProjectDialog()).toBeNull();
		expect(await host.initialize()).toEqual(before);
		await expect(access(join(input.directory, "not-created"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("创建项目真实新建空文件夹，不 init Git、不打开 Core", async () => {
		const input = await fixture();
		const { host } = await openHost(input);
		const before = await host.initialize();
		const create = vi.spyOn(Core.prototype, "createSession");
		electronMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [input.directory] });

		const selection = await host.createProjectDialog("new-project");

		const root = await realpath(join(input.directory, "new-project"));
		expect(selection?.project).toEqual({ root, name: "new-project" });
		expect(await readdir(root)).toEqual([]);
		expect((await host.initialize()).project?.root).toBe(before.taskRoot);
		expect(create).not.toHaveBeenCalled();
	});

	it("非法名称不弹对话框；创建冲突不覆盖、不登记或切工作区", async () => {
		const input = await fixture();
		const existing = await projectDirectory(input, "existing");
		await writeFile(join(existing, "marker.txt"), "keep me");
		const { host } = await openHost(input);
		const before = await host.initialize();

		await expect(host.createProjectDialog("../outside")).rejects.toMatchObject({ code: "invalid-project-name" });
		expect(electronMock.showOpenDialog).not.toHaveBeenCalled();
		electronMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [input.directory] });
		await expect(host.createProjectDialog("existing")).rejects.toMatchObject({ code: "project-exists" });
		expect(await readFile(join(existing, "marker.txt"), "utf8")).toBe("keep me");
		expect(await host.initialize()).toEqual(before);
	});

	it("picker 和显式 project target 都不能把内部任务根当作普通项目", async () => {
		const input = await fixture();
		const { host } = await openHost(input);
		const before = await host.initialize();
		electronMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [before.taskRoot] });

		await expect(host.selectProjectDialog()).rejects.toMatchObject({ code: "invalid-project" });
		await expect(host.prepareWorkspace({ kind: "project", root: before.taskRoot })).rejects.toMatchObject({
			code: "invalid-project",
		});
		expect(await host.initialize()).toEqual(before);
	});
});

describe("DesktopHost explicit session ownership", () => {
	it("tasks 创建/查询不污染 recent；按 target 查询不切已有 Core/租约", async () => {
		const input = await fixture();
		const root = await projectDirectory(input, "project");
		const saved = await savedSession(input.core, root, "project history");
		const { host } = await openHost(input);
		const initial = await host.initialize();
		const task = await host.createSession({ target: { kind: "tasks" } });
		await host.renameSession(task.session.meta.id, "saved task");
		expect(task.project.root).toBe(initial.taskRoot);
		expect(task.project.target).toEqual({ kind: "tasks" });
		expect((await host.initialize()).recentProjects).toEqual([]);

		const prepared = await host.prepareWorkspace({ kind: "project", root });
		expect(prepared.session).toBeUndefined();
		const project = await host.activateSession(saved.meta.id);
		const lease = vi.spyOn(Core.prototype, "acquireSessionLease");
		const open = vi.spyOn(Core.prototype, "openSession");
		const tasks = await host.listSessions({ target: { kind: "tasks" } });
		const current = await host.listSessions({});

		expect(tasks.items.map((session) => session.id)).toEqual([task.session.meta.id]);
		expect(current.items.map((session) => session.id)).toEqual([saved.meta.id]);
		expect((await host.projectSnapshot()).session?.meta.id).toBe(project.session.meta.id);
		expect(host.workspaceRoot()).toBe(root);
		expect(lease).not.toHaveBeenCalled();
		expect(open).not.toHaveBeenCalled();
		expect((await host.initialize()).recentProjects.map((project) => project.root)).toEqual([root]);
		expect((await DesktopStore.open(input.userDataDir)).recentProjects().map((project) => project.root)).toEqual([
			root,
		]);
		await input.core.acquireSessionLease(await input.core.openSession(task.session.meta.id));
		await input.core.releaseSessionLease(task.session.meta.id);
		await expect(input.core.acquireSessionLease(saved)).rejects.toBeInstanceOf(SessionBusyError);
	});

	it("明确 target 创建在新项目而非旧项目，并释放旧根租约", async () => {
		const input = await fixture();
		const firstRoot = await projectDirectory(input, "first");
		const secondRoot = await projectDirectory(input, "second");
		const { host } = await openHost(input);
		await host.initialize();
		const first = await host.createSession({ target: { kind: "project", root: firstRoot } });
		await host.renameSession(first.session.meta.id, "keep first");

		const second = await host.createSession({ target: { kind: "project", root: secondRoot } });

		expect(second.project.target).toEqual({ kind: "project", root: secondRoot });
		expect(second.session.meta.projectRoot).toBe(secondRoot);
		expect(second.project.session).toEqual(second.session);
		expect((await input.core.listSessions(firstRoot)).map((session) => session.id)).toEqual([first.session.meta.id]);
		expect((await input.core.listSessions(secondRoot)).map((session) => session.id)).toEqual([second.session.meta.id]);
		await input.core.acquireSessionLease(await input.core.openSession(first.session.meta.id));
		await input.core.releaseSessionLease(first.session.meta.id);
	});

	it("跨 tasks/project 激活返回正确上下文，其他会话操作仍拒绝跨根及防串消息", async () => {
		const input = await fixture();
		const root = await projectDirectory(input, "project");
		const { host } = await openHost(input);
		const initial = await host.initialize();
		const task = await host.createSession({ target: { kind: "tasks" } });
		await host.renameSession(task.session.meta.id, "keep task");
		const project = await host.createSession({ target: { kind: "project", root } });
		await host.renameSession(project.session.meta.id, "keep project");

		await expect(host.replaySession(task.session.meta.id)).rejects.toThrow("belongs to another project");
		await expect(host.renameSession(task.session.meta.id, "wrong root")).rejects.toThrow("belongs to another project");
		const rejected = await host.deleteSessions([task.session.meta.id]);
		expect(rejected.deleted).toEqual([]);
		expect(rejected.failed).toHaveLength(1);
		const activated = await host.activateSession(task.session.meta.id);

		expect(activated.project.root).toBe(initial.taskRoot);
		expect(activated.project.target).toEqual({ kind: "tasks" });
		expect(activated.session.meta.id).toBe(task.session.meta.id);
		expect(activated.project.session).toEqual(activated.session);
		await expect(host.eventsPage(project.session.meta.id)).rejects.toThrow("belongs to another project");
		await expect(host.send({ sessionId: project.session.meta.id, text: "stale" })).rejects.toThrow(
			"active session changed",
		);
		const back = await host.activateSession(project.session.meta.id);
		expect(back.project.target).toEqual({ kind: "project", root });
		expect(back.session.meta.id).toBe(project.session.meta.id);
	});

	it("删除当前最后会话清空并推送 session-cleared，不补建", async () => {
		const input = await fixture();
		const { host, messages } = await openHost(input);
		await host.initialize();
		const context = await host.createSession({ target: { kind: "tasks" } });
		const create = vi.spyOn(Core.prototype, "createSession");

		const result = await host.deleteSessions([context.session.meta.id]);

		expect(result).toEqual({ deleted: [context.session.meta.id], failed: [] });
		expect((await host.projectSnapshot()).session).toBeUndefined();
		expect((await host.listSessions({})).items).toEqual([]);
		expect(messages).toContainEqual({ type: "session-cleared", sessionId: context.session.meta.id });
		expect(create).not.toHaveBeenCalled();
		expect((await host.settings()).config.approval).toBe("ask");
	});

	it("删除当前会话后仅剩归档历史，也保持无当前会话", async () => {
		const input = await fixture();
		const { host, messages } = await openHost(input);
		const initial = await host.initialize();
		const archived = await savedSession(input.core, initial.taskRoot, "archived");
		await input.core.archiveSession(archived, true);
		const current = await host.createSession({ target: { kind: "tasks" } });

		await host.deleteSessions([current.session.meta.id]);

		expect((await host.initialize()).project?.session).toBeUndefined();
		expect((await host.listSessions({ includeArchived: true })).items.map((session) => session.id)).toEqual([
			archived.meta.id,
		]);
		expect(messages).toContainEqual({ type: "session-cleared", sessionId: current.session.meta.id });
	});

	it("草稿选项在返回前生效且不修改 Core 全局默认配置", async () => {
		const input = await fixture();
		await input.core.upsertProvider("fixture", {
			api: "chat-completions",
			baseUrl: "https://example.invalid/v1",
			models: [{ id: "sample", maxTokens: 1024, contextWindow: 8192, reasoning: true, input: ["text", "image"] }],
		});
		const { host } = await openHost(input);
		await host.initialize();

		const context = await host.createSession({
			target: { kind: "tasks" },
			model: { provider: "fixture", model: "sample" },
			effort: "high",
			approval: "auto",
			plan: true,
		});

		expect(context.session).toMatchObject({
			model: { provider: "fixture", model: "sample" },
			effort: "high",
			approval: "auto",
			plan: true,
		});
		expect(context.project.session).toEqual(context.session);
		const settings = await host.settings();
		expect(settings.config.provider).toBeUndefined();
		expect(settings.config.reasoningEffort).toBe("off");
		expect(settings.config.approval).toBe("ask");
	});

	it("草稿模型选项失败删除新会话/释放租约，原会话不被顶掉", async () => {
		const input = await fixture();
		const { host } = await openHost(input);
		await host.initialize();
		const previous = await host.createSession({ target: { kind: "tasks" } });
		await host.renameSession(previous.session.meta.id, "keep previous");
		const remove = vi.spyOn(Core.prototype, "deleteSession");
		const release = vi.spyOn(Core.prototype, "releaseSessionLease");

		await expect(
			host.createSession({ target: { kind: "tasks" }, model: { provider: "missing", model: "missing" } }),
		).rejects.toThrow();

		expect(remove).toHaveBeenCalledTimes(1);
		const failedId = remove.mock.calls[0]?.[0];
		expect(failedId).toBeTypeOf("string");
		expect(release).toHaveBeenCalledWith(failedId);
		expect((await host.projectSnapshot()).session?.meta.id).toBe(previous.session.meta.id);
		expect((await host.listSessions({})).items.map((session) => session.id)).toEqual([previous.session.meta.id]);
	});

	it("无当前会话时草稿选项失败不留下空会话", async () => {
		const input = await fixture();
		const { host } = await openHost(input);
		await host.initialize();
		vi.spyOn(Core.prototype, "setSessionApproval").mockImplementationOnce(() => {
			throw new Error("option unavailable");
		});

		await expect(
			host.createSession({ target: { kind: "tasks" }, effort: "high", approval: "auto", plan: true }),
		).rejects.toThrow("option unavailable");

		expect((await host.projectSnapshot()).session).toBeUndefined();
		expect(await input.core.listSessions()).toEqual([]);
	});

	it("并发创建/准备请求仍按明确 target 执行，不串根", async () => {
		const input = await fixture();
		const root = await projectDirectory(input, "project");
		const { host } = await openHost(input);
		await host.initialize();

		const [created, prepared] = await Promise.all([
			host.createSession({ target: { kind: "project", root } }),
			host.prepareWorkspace({ kind: "tasks" }),
		]);

		expect(created.session.meta.projectRoot).toBe(root);
		expect(created.project.target).toEqual({ kind: "project", root });
		expect(prepared.target).toEqual({ kind: "tasks" });
		expect(prepared.session).toBeUndefined();
		expect(host.workspaceRoot()).toBe(prepared.root);
	});
});

describe("DesktopHost running drafts and prepared images", () => {
	it("跨根准备返回 workspace-busy；picker 不打断运行，同根新会话/排队会话不会被误清理", async () => {
		const input = await fixture();
		const root = await projectDirectory(input, "selected");
		const { host } = await openHost(input);
		await host.initialize();
		const first = await host.createSession({ target: { kind: "tasks" } });
		let finish = (): void => undefined;
		const pending = new Promise<typeof RUN_RESULT>((resolve) => {
			finish = () => resolve(RUN_RESULT);
		});
		let runs = 0;
		const run = vi.spyOn(Core.prototype, "runSession").mockImplementation(async (session, text) => {
			await session.append({ type: "user.input", payload: { text: text ?? "" } });
			runs += 1;
			return runs === 1 ? pending : RUN_RESULT;
		});
		try {
			await host.send({ sessionId: first.session.meta.id, text: "running" });
			const signal = run.mock.calls[0]?.[2]?.signal;
			await expect(host.prepareWorkspace({ kind: "project", root })).rejects.toMatchObject({ code: "workspace-busy" });
			await expect(host.createSession({ target: { kind: "project", root } })).rejects.toMatchObject({
				code: "workspace-busy",
			});
			electronMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [root] });
			await host.selectProjectDialog();
			expect(signal?.aborted).toBe(false);
			expect((await host.initialize()).project?.target).toEqual({ kind: "tasks" });

			const second = await host.createSession({ target: { kind: "tasks" } });
			expect(await host.send({ sessionId: second.session.meta.id, text: "queued" })).toEqual({ queued: true });
			await host.createSession({ target: { kind: "tasks" } });
			expect((await host.listSessions({})).items.map((session) => session.id)).toContain(second.session.meta.id);
			expect(host.liveState(first.session.meta.id).live.running).toBe(true);
			finish();
			await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
			expect(run.mock.calls[1]?.[0].meta.id).toBe(second.session.meta.id);
			await vi.waitFor(async () => {
				const prepared = await host.prepareWorkspace({ kind: "project", root });
				expect(prepared.target).toEqual({ kind: "project", root });
			});
			await host.dispose();
		} finally {
			finish();
		}
	});

	it("草稿图片跨工作区保留，发送仍交给明确新根的 Core", async () => {
		const input = await fixture();
		const root = await projectDirectory(input, "project");
		const { host } = await openHost(input);
		await host.initialize();
		const image = await host.prepareImageFromBytes(IMAGE_BYTES);
		const context = await host.createSession({ target: { kind: "project", root } });
		const run = vi.spyOn(Core.prototype, "runSession").mockResolvedValue(RUN_RESULT);

		expect(await host.send({ sessionId: context.session.meta.id, text: "image", imageIds: [image.id] })).toEqual({
			queued: false,
		});

		expect(run.mock.calls[0]?.[0].meta.projectRoot).toBe(root);
		expect(run.mock.calls[0]?.[2]?.images).toEqual([
			{ mediaType: "image/gif", width: 1, height: 1, data: IMAGE_BYTES.toString("base64") },
		]);
		await host.dispose();
	});

	it("图片 TTL 在发送时也校验，过期图片不会发送", async () => {
		const input = await fixture();
		const { host } = await openHost(input);
		await host.initialize();
		const context = await host.createSession({ target: { kind: "tasks" } });
		const image = await host.prepareImageFromBytes(IMAGE_BYTES);
		const run = vi.spyOn(Core.prototype, "runSession");
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60 * 1_000);

		await expect(
			host.send({ sessionId: context.session.meta.id, text: "expired", imageIds: [image.id] }),
		).rejects.toThrow("image has expired");

		expect(run).not.toHaveBeenCalled();
	});

	it("准备图片池有数量上限，最旧附件被淘汰", async () => {
		const input = await fixture();
		const { host } = await openHost(input);
		await host.initialize();
		const context = await host.createSession({ target: { kind: "tasks" } });
		const first = await host.prepareImageFromBytes(IMAGE_BYTES);
		for (let i = 0; i < 32; i += 1) await host.prepareImageFromBytes(IMAGE_BYTES);

		await expect(
			host.send({ sessionId: context.session.meta.id, text: "oldest", imageIds: [first.id] }),
		).rejects.toThrow("image has expired");
	});

	it("dispose 后异步完成的图片不会重新进入已释放的准备池", async () => {
		const input = await fixture();
		const { host } = await openHost(input);
		await host.initialize();
		type ImageInput = Awaited<ReturnType<Core["prepareImageUrl"]>>;
		let finish = (_image: ImageInput): void => undefined;
		const pending = new Promise<ImageInput>((resolve) => {
			finish = resolve;
		});
		vi.spyOn(Core.prototype, "prepareImageUrl").mockReturnValue(pending);
		const prepared = host.prepareImageFromUrl("https://example.invalid/image.gif");

		await host.dispose();
		finish({ mediaType: "image/gif", width: 1, height: 1, data: IMAGE_BYTES.toString("base64") });

		await expect(prepared).rejects.toThrow("Application is shutting down");
	});

	it("目标项目有 AGENTS 时选项/计划模式不能绕过首次发送信任门控", async () => {
		const input = await fixture();
		const root = await projectDirectory(input, "untrusted");
		await writeFile(join(root, "AGENTS.md"), "Project instructions");
		const { host } = await openHost(input);
		await host.initialize();
		const prepared = await host.prepareWorkspace({ kind: "project", root });
		expect(prepared.trust).toMatchObject({ required: true, decision: null });
		const context = await host.createSession({ target: { kind: "project", root }, approval: "yolo", plan: true });
		const run = vi.spyOn(Core.prototype, "runSession");

		await expect(host.send({ sessionId: context.session.meta.id, text: "untrusted" })).rejects.toThrow(
			"Workspace trust is required",
		);

		expect(run).not.toHaveBeenCalled();
	});
});

describe("desktop workspace IPC and preload", () => {
	it("IPC 删除最后一个供应商模型后保留空列表，刷新目录与重开宿主不会恢复模型", async () => {
		const input = await fixture();
		await input.core.upsertProvider("fixture", {
			api: "chat-completions",
			baseUrl: "https://example.invalid/v1",
			models: [{ id: "sample", maxTokens: 1024, reasoning: false, input: ["text"] }],
		});
		const { host } = await openHost(input);
		const initial = await host.initialize();
		const client = ipcClient(host);
		expect(initial.project?.models.providers).toMatchObject([{ name: "fixture", models: [{ id: "sample" }] }]);

		const emptyCatalog = { providers: [{ name: "fixture", models: [] }] };
		const emptySettings = {
			ok: true,
			value: {
				providers: [{ name: "fixture", api: "chat-completions", baseUrl: "https://example.invalid/v1", models: [] }],
				skipped: [],
			},
		};
		expect(await client.request(IPC.settingsUpsertProvider, "fixture", { models: [] })).toMatchObject(emptySettings);
		expect(await client.request(IPC.settingsGet)).toMatchObject(emptySettings);
		expect(await client.request(IPC.modelsList)).toEqual({ ok: true, value: emptyCatalog });
		expect((await host.initialize()).project?.models).toEqual(emptyCatalog);

		await host.dispose();
		const { host: reopened } = await openHost(input);
		expect((await reopened.initialize()).project?.models).toEqual(emptyCatalog);
		const reopenedClient = ipcClient(reopened);
		expect(await reopenedClient.request(IPC.settingsGet)).toMatchObject(emptySettings);
		expect(await reopenedClient.request(IPC.modelsList)).toEqual({ ok: true, value: emptyCatalog });
	});

	it("新增 IPC/显式 target schema 与 SessionContext 返回值对齐", async () => {
		const input = await fixture();
		const root = await projectDirectory(input, "project");
		const { host } = await openHost(input);
		await host.initialize();
		const client = ipcClient(host);

		for (const args of [
			[],
			[{}],
			[{ target: { kind: "tasks", root } }],
			[{ target: { kind: "tasks" }, effort: "invalid" }],
		]) {
			expect(await client.request(IPC.sessionsCreate, ...args)).toMatchObject({
				ok: false,
				error: { code: "invalid-request" },
			});
		}
		expect(await client.request(IPC.workspacePrepare, { kind: "project" })).toMatchObject({
			ok: false,
			error: { code: "invalid-request" },
		});
		expect(await client.request(IPC.appSelectProjectDialog)).toEqual({ ok: true, value: null });
		expect(await client.request(IPC.appCreateProjectDialog, "cancelled")).toEqual({ ok: true, value: null });
		expect(await client.request(IPC.workspacePrepare, { kind: "project", root })).toMatchObject({
			ok: true,
			value: { target: { kind: "project", root } },
		});
		expect(
			await client.request(IPC.sessionsCreate, {
				target: { kind: "tasks" },
				effort: "high",
				approval: "auto",
				plan: true,
			}),
		).toMatchObject({
			ok: true,
			value: { project: { target: { kind: "tasks" } }, session: { effort: "high", approval: "auto", plan: true } },
		});
		const currentRoot = host.workspaceRoot();
		expect(await client.request(IPC.sessionsList, { target: { kind: "project", root } })).toEqual({
			ok: true,
			value: { items: [] },
		});
		expect(host.workspaceRoot()).toBe(currentRoot);
	});

	it("工作区忙经 IPC 返回结构化 workspace-busy，不中断原轮次", async () => {
		const input = await fixture();
		const root = await projectDirectory(input, "project");
		const { host } = await openHost(input);
		await host.initialize();
		const context = await host.createSession({ target: { kind: "tasks" } });
		let finish = (): void => undefined;
		const pending = new Promise<typeof RUN_RESULT>((resolve) => {
			finish = () => resolve(RUN_RESULT);
		});
		const run = vi.spyOn(Core.prototype, "runSession").mockReturnValue(pending);
		const client = ipcClient(host);
		try {
			await host.send({ sessionId: context.session.meta.id, text: "running" });
			expect(await client.request(IPC.workspacePrepare, { kind: "project", root })).toMatchObject({
				ok: false,
				error: { code: "workspace-busy" },
			});
			expect(run.mock.calls[0]?.[2]?.signal?.aborted).toBe(false);
			expect(host.workspaceRoot()).toBe(context.project.root);
		} finally {
			finish();
			await host.dispose();
		}
	});

	it("新项目业务错误经 IPC 保留稳定码，未授权发送方仍被拒绝", async () => {
		const input = await fixture();
		await projectDirectory(input, "existing");
		const { host } = await openHost(input);
		await host.initialize();
		const client = ipcClient(host);

		expect(await client.request(IPC.appCreateProjectDialog, "CON")).toMatchObject({
			ok: false,
			error: { code: "invalid-project-name" },
		});
		electronMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [input.directory] });
		expect(await client.request(IPC.appCreateProjectDialog, "existing")).toMatchObject({
			ok: false,
			error: { code: "project-exists" },
		});
		const handler = electronMock.handlers.get(IPC.workspacePrepare);
		if (handler === undefined) throw new Error("Missing workspace prepare handler");
		const untrusted = { ...client.event, senderFrame: {} } as IpcMainInvokeEvent;
		expect(await handler(untrusted, { kind: "tasks" })).toMatchObject({ ok: false, error: { code: "unauthorized" } });
	});

	it("preload 原样转发新 bridge 的 target/input 与新 IPC 键", async () => {
		await import("../src/preload/index.ts");
		const bridge = electronMock.expose.mock.calls[0]?.[1] as DesktopBridge | undefined;
		if (bridge === undefined) throw new Error("Preload bridge was not exposed");
		const target = { kind: "tasks" } as const;
		const input: SessionCreateInput = { target, effort: "high", plan: true };

		await bridge.selectProjectDialog();
		await bridge.createProjectDialog("project");
		await bridge.prepareWorkspace(target);
		await bridge.sessionsCreate(input);
		await bridge.sessionsActivate("session-id");
		await bridge.sessionsList({ target });
		await bridge.chatSend({ sessionId: "session-id", text: "message" });

		expect(electronMock.invoke.mock.calls).toEqual([
			[IPC.appSelectProjectDialog],
			[IPC.appCreateProjectDialog, "project"],
			[IPC.workspacePrepare, target],
			[IPC.sessionsCreate, input],
			[IPC.sessionsActivate, "session-id"],
			[IPC.sessionsList, { target }],
			[IPC.chatSend, { sessionId: "session-id", text: "message" }],
		]);
	});
});
