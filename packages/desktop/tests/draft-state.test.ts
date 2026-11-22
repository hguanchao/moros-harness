import { describe, expect, it } from "vitest";

import type { SessionMeta } from "@moros/core/session/session-manager.ts";

import type {
	AppSnapshot,
	PreparedImage,
	ProjectRef,
	ProjectSelection,
	ProjectSnapshot,
	SessionContext,
	SessionView,
} from "../src/shared/contract.ts";
import { initialState, reducer, type Action, type AppState } from "../src/store/state.tsx";

const PROJECT_REF: ProjectRef = { root: "C:/work/project", name: "Project" };
const TASK_ROOT = "C:/moros/tasks";
const TIMESTAMP = "2026-11-19T00:00:00.000Z";

const SESSION: SessionView = {
	meta: {
		id: "project-session",
		title: "Project session",
		projectRoot: PROJECT_REF.root,
		createdAt: TIMESTAMP,
		updatedAt: TIMESTAMP,
		mode: "standard",
		archived: false,
	},
	readOnly: false,
	running: false,
	model: { provider: "fixture", model: "configured-model" },
	effort: "off",
	approval: "ask",
	plan: false,
	metrics: {
		contextUsed: 0,
		cacheHitRate: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	},
	live: { running: false, paused: false, text: "", reasoning: "", toolOutputs: {} },
	queued: 0,
};
const TASK_META: SessionMeta = {
	...SESSION.meta,
	id: "task-session",
	title: "Task session",
	projectRoot: TASK_ROOT,
};
const PROJECT: ProjectSnapshot = {
	...PROJECT_REF,
	target: { kind: "project", root: PROJECT_REF.root },
	recentProjects: [{ ...PROJECT_REF, lastOpenedAt: TIMESTAMP }],
	trust: { required: false, decision: null, files: [], skillDirectories: [] },
	models: { providers: [] },
	skills: [],
	mcp: [],
	warnings: [],
};
const TASK_WORKSPACE: ProjectSnapshot = {
	...PROJECT,
	root: TASK_ROOT,
	name: "Tasks",
	target: { kind: "tasks" },
};
const CREATED_SESSION: SessionView = {
	...SESSION,
	meta: { ...TASK_META, id: "created-task" },
};
const CREATED_CONTEXT: SessionContext = {
	project: { ...TASK_WORKSPACE, session: CREATED_SESSION },
	session: CREATED_SESSION,
};
const APP: AppSnapshot = {
	version: "test",
	platform: "win32",
	taskRoot: TASK_ROOT,
	recentProjects: PROJECT.recentProjects,
	sidebarWidth: 280,
	pinnedSessionIds: [],
	project: { ...PROJECT, session: SESSION },
};

function makeImage(id: string): PreparedImage {
	return { id, mediaType: "image/png", width: 1, height: 1, bytes: 1, dataUrl: "data:image/png;base64,AA==" };
}

function activeState(): AppState {
	const initialized = reducer(initialState, { type: "init", app: APP });
	return reducer(initialized, { type: "sessions", items: [SESSION.meta, TASK_META] });
}

function populatedDraft(state: AppState = activeState()): AppState {
	const task = reducer(state, { type: "new-task" });
	const withText = reducer(task, { type: "draft-text", text: "Unsent task" });
	return reducer(withText, {
		type: "draft-image-added",
		image: makeImage("sent-image"),
		generation: task.draftGeneration,
	});
}

describe("renderer task draft state", () => {
	it("init 没有会话时不保留旧 current", () => {
		const before = activeState();
		const next = reducer(before, { type: "init", app: { ...APP, project: PROJECT } });

		expect(before.current).toBe(SESSION);
		expect(next.current).toBeUndefined();
		expect(next.project).toBe(PROJECT);
		expect(next.ready).toBe(true);
	});

	it("new-task 离开项目会话，重置未关联草稿但沿用该会话的模型与思考强度", () => {
		const before: AppState = {
			...activeState(),
			page: "settings",
			isNavigating: true,
			draft: {
				text: "Old input",
				images: [makeImage("old-image")],
				project: PROJECT_REF,
				branch: "feature/old",
				model: { provider: "fixture", model: "chosen-model" },
				effort: "high",
				approval: "auto",
				plan: true,
			},
			draftRevision: 3,
			draftWorkspace: PROJECT.target,
		};
		const next = reducer(before, { type: "new-task" });

		// 模型与思考强度取自上一会话的当前选择，而非旧草稿残留值；审批档位与计划模式不继承
		expect(next.draft).toEqual({
			text: "",
			images: [],
			branch: undefined,
			project: null,
			model: SESSION.model,
			effort: SESSION.effort,
			approval: undefined,
			plan: false,
		});
		expect(next).toMatchObject({
			current: undefined,
			page: "chat",
			isNavigating: false,
			draftGeneration: before.draftGeneration + 1,
			draftRevision: 0,
			draftWorkspace: undefined,
		});
		expect(next.sessions).toBe(before.sessions);
		expect(next.project).toBe(before.project);
	});

	it("new-task 无上一会话时不携带模型与思考强度", () => {
		const before = { ...activeState(), current: undefined };
		const next = reducer(before, { type: "new-task" });
		expect(next.draft.model).toBeUndefined();
		expect(next.draft.effort).toBeUndefined();
	});

	it("会话恢复、进入草稿与创建任务时维护顶栏导航历史", () => {
		const restored = reducer(initialState, { type: "init", app: APP });
		expect(restored.history).toEqual([{ type: "session", sessionId: SESSION.meta.id }]);
		expect(restored.historyIndex).toBe(0);

		const task = reducer(restored, { type: "new-task" });
		expect(task.history).toEqual([{ type: "session", sessionId: SESSION.meta.id }, { type: "new-task" }]);
		expect(task.historyIndex).toBe(1);
		expect(reducer(task, { type: "new-task" })).toBe(task);

		const created = reducer(populatedDraft(), {
			type: "session-created",
			context: CREATED_CONTEXT,
			generation: populatedDraft().draftGeneration,
		});
		expect(created.history).toEqual([
			{ type: "session", sessionId: SESSION.meta.id },
			{ type: "session", sessionId: CREATED_CONTEXT.session.meta.id },
		]);
		expect(created.historyIndex).toBe(1);
	});

	it("后退后新增记录会丢弃前进分支，view-new-task 保留草稿", () => {
		const first = reducer(activeState(), { type: "new-task" });
		const extended = reducer(first, {
			type: "history-entry",
			entry: { type: "session", sessionId: "other-session" },
		});
		const back = reducer(extended, { type: "history-index", index: 1 });
		const branched = reducer(back, {
			type: "history-entry",
			entry: { type: "session", sessionId: "branch-session" },
		});
		expect(branched.history).toEqual([
			{ type: "session", sessionId: SESSION.meta.id },
			{ type: "new-task" },
			{ type: "session", sessionId: "branch-session" },
		]);
		expect(branched.historyIndex).toBe(2);

		const draft = populatedDraft();
		const viewed = reducer(draft, { type: "view-new-task" });
		expect(viewed.current).toBeUndefined();
		expect(viewed.draft).toBe(draft.draft);
		expect(viewed.draftGeneration).toBe(draft.draftGeneration);
	});

	it("切换项目重置历史，keepHistory 激活会话时保留", () => {
		const task = reducer(activeState(), { type: "new-task" });
		const kept = reducer(task, {
			type: "open-project",
			project: { ...PROJECT, session: SESSION },
			keepHistory: true,
		});
		expect(kept.history).toEqual(task.history);

		const reset = reducer(kept, { type: "open-project", project: PROJECT });
		expect(reset.history).toEqual([{ type: "new-task" }]);
		expect(reset.historyIndex).toBe(0);

		const cleared = reducer(activeState(), {
			type: "push",
			message: { type: "session-cleared", sessionId: SESSION.meta.id },
		});
		expect(cleared.history).toEqual([{ type: "new-task" }]);
	});

	it("new-task 已在草稿页时保留已选项目、分支和输入", () => {
		const draft = reducer(populatedDraft(), { type: "draft-branch", branch: "feature/current" });
		const before: AppState = {
			...draft,
			draft: { ...draft.draft, project: PROJECT_REF, branch: "feature/current" },
			page: "files",
		};
		const same = reducer(before, { type: "new-task" });
		const again = reducer(same, { type: "new-task" });

		expect(same.page).toBe("chat");
		expect(again).toBe(same);
		expect(again.draft).toEqual(before.draft);
		expect(again.draftGeneration).toBe(before.draftGeneration);
		expect(again.draftRevision).toBe(before.draftRevision);
	});

	it("分组新建任务关联明确项目或清空归属，保留已输入内容", () => {
		const draft = populatedDraft();
		const otherProject: ProjectRef = { root: "C:/work/other", name: "Other" };

		const associated = reducer(reducer(draft, { type: "new-task" }), {
			type: "draft-project",
			project: otherProject,
		});
		expect(associated.draft.project).toEqual(otherProject);
		expect(associated.draft.branch).toBeUndefined();
		expect(associated.draft.text).toBe(draft.draft.text);
		expect(associated.draft.images).toBe(draft.draft.images);
		expect(associated.draftRevision).toBe(draft.draftRevision);

		const cleared = reducer(reducer(associated, { type: "new-task" }), { type: "draft-project", project: null });
		expect(cleared.draft.project).toBeNull();
		expect(cleared.draft.text).toBe(draft.draft.text);
		expect(cleared.draft.images).toBe(draft.draft.images);
	});

	it("init 带入持久化的置顶 ID 并支持推送更新", () => {
		const before = activeState();
		const initialized = reducer(before, {
			type: "init",
			app: { ...APP, pinnedSessionIds: ["task-session"] },
		});
		expect(initialized.pinnedSessionIds).toEqual(["task-session"]);

		const updated = reducer(initialized, {
			type: "push",
			message: { type: "session-pins", ids: ["project-session", "task-session"] },
		});
		expect(updated.pinnedSessionIds).toEqual(["project-session", "task-session"]);
	});

	it("init 带入持久化的侧栏宽度，拖拽动作与推送均更新宽度", () => {
		const initialized = reducer(initialState, {
			type: "init",
			app: { ...APP, sidebarWidth: 320 },
		});
		expect(initialized.sidebarWidth).toBe(320);

		const dragged = reducer(initialized, { type: "sidebar-width", width: 300 });
		expect(dragged.sidebarWidth).toBe(300);

		const pushed = reducer(dragged, { type: "push", message: { type: "sidebar-width", width: 288 } });
		expect(pushed.sidebarWidth).toBe(288);
	});

	it("迟到的 init 和项目更新不覆盖已经进入的新草稿", () => {
		const before = reducer(populatedDraft(), {
			type: "draft-options",
			options: {
				model: { provider: "fixture", model: "chosen-model" },
				effort: "high",
				approval: "auto",
				plan: true,
			},
		});
		const initialized = reducer(before, { type: "init", app: APP });
		const project: ProjectSnapshot = { ...PROJECT, session: SESSION, warnings: ["Updated configuration"] };
		const updates: readonly Action[] = [
			{ type: "project", project },
			{ type: "push", message: { type: "project", project } },
		];

		for (const next of [initialized, ...updates.map((action) => reducer(initialized, action))]) {
			expect(next.current).toBeUndefined();
			expect(next.draft).toEqual(before.draft);
			expect(next.draftGeneration).toBe(before.draftGeneration);
			expect(next.draftRevision).toBe(before.draftRevision);
		}
	});

	it("选择或清除项目保留文字和附件，迟到的项目选择不重新关联", () => {
		const draft = populatedDraft();
		const before = reducer(draft, {
			type: "prepare-workspace",
			project: TASK_WORKSPACE,
			generation: draft.draftGeneration,
		});
		const selection: ProjectSelection = {
			project: PROJECT_REF,
			recentProjects: [{ ...PROJECT_REF, lastOpenedAt: "2026-11-19T01:00:00.000Z" }],
		};
		const selected = reducer(before, { type: "project-selected", selection, generation: before.draftGeneration });

		expect(selected.draft).toEqual({ ...before.draft, project: PROJECT_REF });
		expect(selected.draft.images).toBe(before.draft.images);
		expect(selected.draftRevision).toBe(before.draftRevision);
		expect(selected.draftWorkspace).toBeUndefined();
		expect(selected.app?.recentProjects).toBe(selection.recentProjects);
		// 显式清除关联才 dispatch null；目录对话框取消不产生 reducer action。
		const cleared = reducer(selected, { type: "draft-project", project: null });
		expect(cleared.draft).toEqual(before.draft);
		expect(cleared.draft.images).toBe(before.draft.images);
		expect(cleared.draftRevision).toBe(before.draftRevision);

		const stale = reducer(before, { type: "project-selected", selection, generation: before.draftGeneration - 1 });
		expect(stale.draft).toBe(before.draft);
		expect(stale.draftWorkspace).toBe(before.draftWorkspace);
		expect(stale.current).toBeUndefined();
	});

	it("prepared workspace 必须同时匹配草稿 target 和 generation", () => {
		const task = populatedDraft();
		const associated = reducer(task, { type: "draft-project", project: PROJECT_REF });
		const otherProject: ProjectSnapshot = {
			...PROJECT,
			root: "C:/work/other",
			target: { kind: "project", root: "C:/work/other" },
		};
		const rejected: readonly Action[] = [
			{ type: "prepare-workspace", project: PROJECT, generation: associated.draftGeneration - 1 },
			{ type: "prepare-workspace", project: TASK_WORKSPACE, generation: associated.draftGeneration },
			{ type: "prepare-workspace", project: otherProject, generation: associated.draftGeneration },
		];
		for (const action of rejected) expect(reducer(associated, action)).toBe(associated);

		const prepared = reducer(associated, {
			type: "prepare-workspace",
			project: PROJECT,
			generation: associated.draftGeneration,
		});
		expect(prepared.project).toBe(PROJECT);
		expect(prepared.draftWorkspace).toBe(PROJECT.target);
		expect(prepared.draft).toBe(associated.draft);
		expect(prepared.current).toBeUndefined();

		const internal = reducer(task, {
			type: "prepare-workspace",
			project: TASK_WORKSPACE,
			generation: task.draftGeneration,
		});
		expect(internal.project).toBe(TASK_WORKSPACE);
		expect(internal.draftWorkspace).toEqual({ kind: "tasks" });
		expect(internal.draft.project).toBeNull();
	});

	it("session-created 保留 generation 和 revision，让同版本 draft-sent 清理输入", () => {
		const draft = populatedDraft();
		const prepared = reducer(draft, {
			type: "prepare-workspace",
			project: TASK_WORKSPACE,
			generation: draft.draftGeneration,
		});
		const created = reducer(prepared, {
			type: "session-created",
			context: CREATED_CONTEXT,
			generation: draft.draftGeneration,
		});

		expect(created.current).toBe(CREATED_CONTEXT.session);
		expect(created.project).toBe(CREATED_CONTEXT.project);
		expect(created.draft).toBe(draft.draft);
		expect(created.draftGeneration).toBe(draft.draftGeneration);
		expect(created.draftRevision).toBe(draft.draftRevision);
		expect(created.draftWorkspace).toBeUndefined();
		const sent = reducer(created, {
			type: "draft-sent",
			generation: draft.draftGeneration,
			revision: draft.draftRevision,
			imageIds: ["sent-image"],
		});
		expect(sent.draft).toEqual({ ...draft.draft, text: "", images: [] });
		expect(sent.current).toBe(CREATED_CONTEXT.session);
		expect(sent.draftRevision).toBe(draft.draftRevision + 1);
	});

	it("迟到的 session-created 不激活已离开的任务", () => {
		const pending = populatedDraft();
		const replacement: AppState = {
			...pending,
			draft: { ...pending.draft, text: "", images: [] },
			draftGeneration: pending.draftGeneration + 1,
			draftRevision: 0,
		};
		const next = reducer(replacement, {
			type: "session-created",
			context: CREATED_CONTEXT,
			generation: pending.draftGeneration,
		});

		expect(next).toBe(replacement);
		expect(next.current).toBeUndefined();
	});

	it("draft-sent generation 不同，即使 revision 相同也不清除新任务", () => {
		const pending = populatedDraft();
		const replacement: AppState = {
			...pending,
			draft: {
				...pending.draft,
				text: "Replacement task",
				images: [...pending.draft.images, makeImage("new-image")],
			},
			draftGeneration: pending.draftGeneration + 1,
			draftRevision: pending.draftRevision,
		};
		expect(replacement.draftRevision).toBe(pending.draftRevision);

		const next = reducer(replacement, {
			type: "draft-sent",
			generation: pending.draftGeneration,
			revision: pending.draftRevision,
			imageIds: ["sent-image"],
		});
		expect(next).toBe(replacement);
	});

	it("draft-sent 遇到编辑版本变化保留新文字，仅移除已发送附件", () => {
		const pending = populatedDraft();
		const withText = reducer(pending, { type: "draft-text", text: "Edited while sending" });
		const edited = reducer(withText, {
			type: "draft-image-added",
			image: makeImage("new-image"),
			generation: pending.draftGeneration,
		});
		const next = reducer(edited, {
			type: "draft-sent",
			generation: pending.draftGeneration,
			revision: pending.draftRevision,
			imageIds: ["sent-image"],
		});

		expect(next.draft.text).toBe("Edited while sending");
		expect(next.draft.images).toEqual([makeImage("new-image")]);
		expect(next.draftRevision).toBe(edited.draftRevision + 1);
	});

	it("归档 metadata 更新列表和当前元数据，但不把新草稿重新选为会话", () => {
		const before = activeState();
		const meta: SessionMeta = { ...SESSION.meta, title: "Archived session", archived: true };
		const action: Action = { type: "push", message: { type: "session-updated", meta } };
		const updated = reducer(before, action);

		expect(updated.sessions).toEqual([meta, TASK_META]);
		expect(updated.current?.meta).toBe(meta);
		expect(updated.current?.live).toBe(SESSION.live);
		const draft = populatedDraft(before);
		const pushed = reducer(draft, action);
		expect(pushed.sessions).toEqual([meta, TASK_META]);
		expect(pushed.current).toBeUndefined();
		expect(pushed.draft).toBe(draft.draft);
		expect(pushed.draftGeneration).toBe(draft.draftGeneration);
	});

	it("session-cleared 删除最后一个当前会话后回到新任务并沿用其模型选择", () => {
		const before: AppState = {
			...activeState(),
			sessions: [SESSION.meta],
			draft: { ...initialState.draft, text: "Old input", images: [makeImage("old-image")], project: PROJECT_REF },
			draftRevision: 2,
			draftWorkspace: PROJECT.target,
		};
		const next = reducer(before, {
			type: "push",
			message: { type: "session-cleared", sessionId: SESSION.meta.id },
		});

		expect(next.sessions).toEqual([]);
		expect(next.current).toBeUndefined();
		// 新草稿清空输入，但沿用被删会话的模型与思考强度
		expect(next.draft).toEqual({ ...initialState.draft, model: SESSION.model, effort: SESSION.effort });
		expect(next.draftGeneration).toBe(before.draftGeneration + 1);
		expect(next.draftRevision).toBe(0);
		expect(next.draftWorkspace).toBeUndefined();
		expect(next.sessionsVersion).toBe(before.sessionsVersion + 1);
		expect(next.page).toBe("chat");
	});

	it("异步附件拒绝旧 generation 和重复 id，并限制为 8 张", () => {
		const previous = populatedDraft();
		const task: AppState = {
			...previous,
			draft: { ...previous.draft, text: "", images: [] },
			draftGeneration: previous.draftGeneration + 1,
			draftRevision: 0,
		};
		expect(
			reducer(task, {
				type: "draft-image-added",
				image: makeImage("late-image"),
				generation: previous.draftGeneration,
			}),
		).toBe(task);

		let filled = task;
		for (let index = 0; index < 8; index++) {
			filled = reducer(filled, {
				type: "draft-image-added",
				image: makeImage(`image-${index}`),
				generation: task.draftGeneration,
			});
		}
		expect(filled.draft.images).toHaveLength(8);
		expect(filled.draftRevision).toBe(8);
		expect(
			reducer(filled, { type: "draft-image-added", image: makeImage("image-0"), generation: task.draftGeneration }),
		).toBe(filled);

		const overflow = reducer(filled, {
			type: "draft-image-added",
			image: makeImage("ninth-image"),
			generation: task.draftGeneration,
		});
		expect(overflow.draft.images).toBe(filled.draft.images);
		expect(overflow.draftRevision).toBe(filled.draftRevision);
		// 超出图片上限时静默忽略，不再产生任何提示消息。
		expect(overflow).toBe(filled);
	});
});

describe("draft-text-append 划词引用", () => {
	it("追加引用文本到草稿末尾并递增 revision", () => {
		const base = reducer(reducer(activeState(), { type: "new-task" }), { type: "draft-text", text: "问题：" });
		const appended = reducer(base, { type: "draft-text-append", text: "> 引用原文\n\n" });
		expect(appended.draft.text).toBe("问题：> 引用原文\n\n");
		expect(appended.draftRevision).toBe(base.draftRevision + 1);
	});

	it("空文本不产生变化", () => {
		const base = reducer(activeState(), { type: "new-task" });
		expect(reducer(base, { type: "draft-text-append", text: "" })).toBe(base);
	});
});
