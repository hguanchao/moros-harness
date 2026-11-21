import { createContext, useContext, useReducer, type Dispatch, type JSX, type ReactNode } from "react";

import type { SettingsSnapshot } from "@moros/core/config/settings.ts";
import type { EventRecord } from "@moros/core/events/schema.ts";
import type { ModelCatalog } from "@moros/core/core.ts";
import type { SessionMeta } from "@moros/core/session/session-manager.ts";
import type {
	AppSnapshot,
	ApprovalCard,
	LiveState,
	PreparedImage,
	ProjectRef,
	ProjectSelection,
	ProjectSnapshot,
	PushMessage,
	QueuedMessage,
	RecentProject,
	SessionContext,
	SessionView,
	WorkspaceTarget,
	WorkspaceTrustView,
} from "../shared/contract.ts";
import { DEFAULT_SIDEBAR_WIDTH } from "../shared/contract.ts";
import { createTaskDraft, MAX_DRAFT_IMAGES, type TaskDraft } from "./draft.ts";
import { workspaceTarget, workspaceTargetsMatch } from "../utils/workspace.ts";

export type Page = "chat" | "files" | "changes" | "trace" | "sessions" | "settings";

/** 顶栏前进/后退记录：只保存可恢复的会话或新建任务视图。 */
export type HistoryEntry = { readonly type: "new-task" } | { readonly type: "session"; readonly sessionId: string };
export type ThemeChoice = "auto" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export interface Notice {
	readonly id: number;
	readonly level: "info" | "warn" | "error";
	readonly message: string;
}

export interface ReviewState {
	readonly runId: string;
	readonly state: "running" | "done" | "error";
	readonly report?: string;
	readonly error?: string;
}

export interface SubagentProgressView {
	readonly steps: number;
	readonly totalTokens: number;
	readonly elapsedMs: number;
}

export interface AppState {
	readonly ready: boolean;
	readonly loadError: string | undefined;
	readonly isNavigating: boolean;
	readonly isSending: boolean;
	readonly history: readonly HistoryEntry[];
	readonly historyIndex: number;
	readonly draft: TaskDraft;
	/** 导航代次与编辑版本分开记录，迟到的发送不能清掉新任务或新输入。 */
	readonly draftGeneration: number;
	readonly draftRevision: number;
	readonly draftWorkspace: WorkspaceTarget | undefined;
	readonly app: AppSnapshot | undefined;
	readonly project: ProjectSnapshot | undefined;
	readonly page: Page;
	readonly sidebarOpen: boolean;
	/** 侧栏宽度（px），从宿主持久化状态读取，拖拽时更新。 */
	readonly sidebarWidth: number;
	readonly sessions: readonly SessionMeta[];
	/** 侧栏本地置顶的会话 ID；按最近置顶时间排序。 */
	readonly pinnedSessionIds: readonly string[];
	readonly sessionsVersion: number;
	readonly current: SessionView | undefined;
	readonly events: Readonly<Record<string, readonly EventRecord[]>>;
	readonly live: Readonly<Record<string, LiveState>>;
	readonly queue: Readonly<Record<string, readonly QueuedMessage[]>>;
	readonly subagents: Readonly<Record<string, Readonly<Record<string, SubagentProgressView>>>>;
	readonly approvals: readonly ApprovalCard[];
	readonly notices: readonly Notice[];
	readonly runStates: Readonly<Record<string, "running" | "paused" | "idle" | "error">>;
	readonly settings: SettingsSnapshot | undefined;
	readonly models: ModelCatalog;
	readonly theme: ThemeChoice;
	readonly uiFontSize: number;
	readonly resolvedTheme: ResolvedTheme;
	readonly workspaceVersion: number;
	readonly review: ReviewState | undefined;
	readonly windowMaximized: boolean;
}

export type Action =
	| {
			readonly type: "init";
			readonly app: AppSnapshot;
			readonly settings?: SettingsSnapshot;
			readonly shouldRestoreSession?: boolean;
	  }
	| { readonly type: "new-task" }
	| { readonly type: "view-new-task" }
	| { readonly type: "history-entry"; readonly entry: HistoryEntry }
	| { readonly type: "history-index"; readonly index: number }
	| { readonly type: "navigation-loading"; readonly isLoading: boolean }
	| { readonly type: "sending"; readonly isSending: boolean }
	| { readonly type: "draft-text"; readonly text: string }
	| { readonly type: "draft-image-added"; readonly image: PreparedImage; readonly generation: number }
	| { readonly type: "draft-image-removed"; readonly id: string }
	| { readonly type: "draft-project"; readonly project: ProjectRef | null }
	| { readonly type: "draft-branch"; readonly branch: string | undefined }
	| { readonly type: "project-selected"; readonly selection: ProjectSelection; readonly generation: number }
	| {
			readonly type: "draft-options";
			readonly options: Partial<Pick<TaskDraft, "model" | "effort" | "approval" | "plan">>;
	  }
	| {
			readonly type: "draft-sent";
			readonly generation: number;
			readonly revision: number;
			readonly imageIds: readonly string[];
	  }
	| { readonly type: "prepare-workspace"; readonly project: ProjectSnapshot; readonly generation: number }
	| { readonly type: "session-created"; readonly context: SessionContext; readonly generation: number }
	| {
			readonly type: "open-project";
			readonly project: ProjectSnapshot;
			/** 会话激活与前进/后退保留历史；真正打开项目时重置。 */
			readonly keepHistory?: boolean;
	  }
	| { readonly type: "project"; readonly project: ProjectSnapshot }
	| { readonly type: "sessions"; readonly items: readonly SessionMeta[] }
	| { readonly type: "pinned-sessions"; readonly ids: readonly string[] }
	| { readonly type: "recent-projects"; readonly projects: readonly RecentProject[] }
	| { readonly type: "session"; readonly view: SessionView }
	| { readonly type: "events"; readonly sessionId: string; readonly events: readonly EventRecord[] }
	| {
			readonly type: "live-snapshot";
			readonly sessionId: string;
			readonly live: LiveState;
			readonly queued: readonly QueuedMessage[];
	  }
	| { readonly type: "push"; readonly message: PushMessage }
	| { readonly type: "page"; readonly page: Page }
	| { readonly type: "sidebar"; readonly open: boolean }
	| { readonly type: "sidebar-width"; readonly width: number }
	| { readonly type: "settings"; readonly settings: SettingsSnapshot }
	| { readonly type: "models"; readonly models: ModelCatalog }
	| { readonly type: "resolved-theme"; readonly theme: ResolvedTheme }
	| { readonly type: "theme"; readonly theme: ThemeChoice }
	| { readonly type: "trust"; readonly trust: WorkspaceTrustView }
	| { readonly type: "sessions-changed" }
	| { readonly type: "notice"; readonly level: Notice["level"]; readonly message: string }
	| { readonly type: "dismiss-notice"; readonly id: number }
	| { readonly type: "clear-review" }
	| { readonly type: "error"; readonly message: string };

const EMPTY_LIVE: LiveState = {
	running: false,
	paused: false,
	text: "",
	reasoning: "",
	toolOutputs: {},
};

export const initialState: AppState = {
	ready: false,
	loadError: undefined,
	isNavigating: false,
	isSending: false,
	history: [{ type: "new-task" }],
	historyIndex: 0,
	draft: createTaskDraft(),
	draftGeneration: 0,
	draftRevision: 0,
	draftWorkspace: undefined,
	app: undefined,
	project: undefined,
	current: undefined,
	settings: undefined,
	review: undefined,
	page: "chat",
	sidebarOpen: true,
	sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
	sessions: [],
	pinnedSessionIds: [],
	sessionsVersion: 0,
	events: {},
	live: {},
	queue: {},
	subagents: {},
	approvals: [],
	notices: [],
	runStates: {},
	models: { providers: [] },
	theme: "auto",
	uiFontSize: 14,
	resolvedTheme: "dark",
	workspaceVersion: 0,
	windowMaximized: false,
};

let noticeSequence = 0;

export function reducer(state: AppState, action: Action): AppState {
	switch (action.type) {
		case "init": {
			const shouldRestore = action.shouldRestoreSession !== false && state.draftGeneration === 0;
			const project = state.ready && !shouldRestore ? state.project : action.app.project;
			const settings = action.settings ?? state.settings;
			const draft = state.draft;
			const current = shouldRestore ? project?.session : state.current;
			const restoredEntry: HistoryEntry =
				current === undefined ? { type: "new-task" } : { type: "session", sessionId: current.meta.id };
			const history = shouldRestore ? [restoredEntry] : state.history;
			return {
				...state,
				ready: true,
				loadError: undefined,
				history,
				historyIndex: shouldRestore ? 0 : Math.min(state.historyIndex, history.length - 1),
				app: action.app,
				pinnedSessionIds: action.app.pinnedSessionIds,
				sidebarWidth: action.app.sidebarWidth,
				project,
				settings,
				draft,
				theme: themeFromSettings(settings) ?? state.theme,
				uiFontSize: settings?.config.ui.fontSize ?? state.uiFontSize,
				models: project?.models ?? state.models,
				current,
				draftWorkspace:
					current === undefined &&
					project !== undefined &&
					workspaceTargetsMatch(project.target, workspaceTarget(draft.project), action.app.platform)
						? project.target
						: undefined,
				...(current === undefined ? {} : { live: { ...state.live, [current.meta.id]: current.live } }),
			};
		}
		case "new-task":
			// 已在新建草稿页时重复点击只回到聊天页，不清空已选项目、分支与输入。
			if (state.current === undefined) {
				return state.page === "chat" ? state : { ...state, page: "chat" };
			}
			return { ...newTaskState(state), ...pushHistory(state, { type: "new-task" }) };
		case "view-new-task":
			return {
				...state,
				current: undefined,
				page: "chat",
				loadError: undefined,
				isNavigating: false,
				review: undefined,
				draftWorkspace: undefined,
			};
		case "history-entry":
			return { ...state, ...pushHistory(state, action.entry) };
		case "history-index":
			return action.index < 0 || action.index >= state.history.length || action.index === state.historyIndex
				? state
				: { ...state, historyIndex: action.index };
		case "navigation-loading":
			return { ...state, isNavigating: action.isLoading };
		case "sending":
			return { ...state, isSending: action.isSending };
		case "draft-text":
			return action.text === state.draft.text
				? state
				: { ...state, draft: { ...state.draft, text: action.text }, draftRevision: state.draftRevision + 1 };
		case "draft-image-added": {
			if (
				action.generation !== state.draftGeneration ||
				state.draft.images.some((image) => image.id === action.image.id)
			) {
				return state;
			}
			if (state.draft.images.length >= MAX_DRAFT_IMAGES) {
				return { ...state, notices: pushNotice(state.notices, "warn", `最多附加 ${MAX_DRAFT_IMAGES} 张图片`) };
			}
			return {
				...state,
				draft: { ...state.draft, images: [...state.draft.images, action.image] },
				draftRevision: state.draftRevision + 1,
			};
		}
		case "draft-image-removed":
			return {
				...state,
				draft: { ...state.draft, images: state.draft.images.filter((image) => image.id !== action.id) },
				draftRevision: state.draftRevision + 1,
			};
		case "draft-project":
			return state.current === undefined
				? {
						...state,
						draft: { ...state.draft, project: action.project, branch: undefined },
						draftWorkspace: undefined,
					}
				: state;
		case "draft-branch":
			return state.current === undefined ? { ...state, draft: { ...state.draft, branch: action.branch } } : state;
		case "project-selected": {
			const canAssociate = action.generation === state.draftGeneration && state.current === undefined;
			return {
				...state,
				app: appWithRecentProjects(state.app, action.selection.recentProjects),
				sessionsVersion: state.sessionsVersion + 1,
				...(canAssociate
					? {
							draft: { ...state.draft, project: action.selection.project, branch: undefined },
							draftWorkspace: undefined,
						}
					: {}),
			};
		}
		case "draft-options":
			return { ...state, draft: { ...state.draft, ...action.options } };
		case "draft-sent": {
			if (action.generation !== state.draftGeneration) return state;
			const images = state.draft.images.filter((image) => !action.imageIds.includes(image.id));
			return {
				...state,
				draft: {
					...state.draft,
					text: action.revision === state.draftRevision ? "" : state.draft.text,
					images,
				},
				draftRevision: state.draftRevision + 1,
			};
		}
		case "prepare-workspace": {
			if (
				action.generation !== state.draftGeneration ||
				state.current !== undefined ||
				!workspaceTargetsMatch(
					action.project.target,
					workspaceTarget(state.draft.project),
					state.app?.platform ?? "win32",
				)
			) {
				return state;
			}
			return { ...updateWorkspace(state, action.project), draftWorkspace: action.project.target, loadError: undefined };
		}
		case "session-created": {
			if (action.generation !== state.draftGeneration) return state;
			return {
				...selectSession(updateWorkspace(state, action.context.project), action.context.session),
				...enterCreatedSession(state, action.context.session.meta.id),
				draftWorkspace: undefined,
			};
		}
		case "open-project": {
			const entry: HistoryEntry =
				action.project.session === undefined
					? { type: "new-task" }
					: { type: "session", sessionId: action.project.session.meta.id };
			return {
				...updateWorkspace(state, action.project),
				current: action.project.session,
				draft: createTaskDraft(),
				draftGeneration: state.draftGeneration + 1,
				draftRevision: 0,
				draftWorkspace: undefined,
				sessionsVersion: state.sessionsVersion + 1,
				loadError: undefined,
				page: "chat",
				ready: true,
				...(action.keepHistory === true ? {} : resetHistory(entry)),
			};
		}
		case "project":
			return state.project?.root === action.project.root ? updateWorkspace(state, action.project) : state;
		case "sessions":
			return { ...state, sessions: action.items };
		case "pinned-sessions":
			return { ...state, pinnedSessionIds: action.ids };
		case "recent-projects":
			return {
				...state,
				app: state.app === undefined ? undefined : { ...state.app, recentProjects: action.projects },
				sessionsVersion: state.sessionsVersion + 1,
			};
		case "session":
			return {
				...selectSession(state, action.view),
				draftGeneration: state.draftGeneration + 1,
				draftWorkspace: undefined,
			};
		case "events": {
			const existing = state.events[action.sessionId] ?? [];
			const merged = mergeEvents(existing, action.events);
			return { ...state, events: { ...state.events, [action.sessionId]: merged } };
		}
		case "live-snapshot":
			return {
				...state,
				live: { ...state.live, [action.sessionId]: action.live },
				queue: { ...state.queue, [action.sessionId]: action.queued },
				...(state.current?.meta.id === action.sessionId
					? { current: { ...state.current, live: action.live, queued: action.queued.length } }
					: {}),
			};
		case "push":
			return applyPush(state, action.message);
		case "page":
			return { ...state, page: action.page };
		case "sidebar":
			return { ...state, sidebarOpen: action.open };
		case "sidebar-width":
			return { ...state, sidebarWidth: action.width };
		case "settings":
			return {
				...state,
				settings: action.settings,
				theme: action.settings.config.ui.theme,
				uiFontSize: action.settings.config.ui.fontSize,
			};
		case "models":
			return {
				...state,
				models: action.models,
				...(state.project === undefined ? {} : { project: { ...state.project, models: action.models } }),
			};
		case "resolved-theme":
			return { ...state, resolvedTheme: action.theme };
		case "theme":
			return { ...state, theme: action.theme };
		case "trust":
			return {
				...state,
				...(state.project === undefined ? {} : { project: { ...state.project, trust: action.trust } }),
			};
		case "sessions-changed":
			return { ...state, sessionsVersion: state.sessionsVersion + 1 };
		case "notice":
			return {
				...state,
				notices: [...state.notices.slice(-4), { id: ++noticeSequence, level: action.level, message: action.message }],
			};
		case "dismiss-notice":
			return { ...state, notices: state.notices.filter((notice) => notice.id !== action.id) };
		case "clear-review":
			return { ...state, review: undefined };
		case "error":
			return { ...state, ready: true, loadError: action.message };
	}
}

function applyPush(state: AppState, message: PushMessage): AppState {
	switch (message.type) {
		case "event": {
			const existing = state.events[message.sessionId] ?? [];
			const live = state.live[message.sessionId];
			let nextLive = live;
			if (live !== undefined) {
				if (message.event.type === "llm.request" || message.event.type === "llm.response") {
					nextLive = { ...live, text: "", reasoning: "" };
				} else if (message.event.type === "tool.result") {
					const outputs = { ...live.toolOutputs };
					delete outputs[message.event.payload.toolCallId];
					nextLive = { ...live, toolOutputs: outputs };
				}
			}
			return {
				...state,
				events: { ...state.events, [message.sessionId]: mergeEvents(existing, [message.event]) },
				...(nextLive === undefined ? {} : { live: { ...state.live, [message.sessionId]: nextLive } }),
				...(nextLive !== undefined && state.current?.meta.id === message.sessionId
					? { current: { ...state.current, live: nextLive } }
					: {}),
			};
		}
		case "stream": {
			const live = state.live[message.sessionId] ?? EMPTY_LIVE;
			const key = message.kind === "text" ? "text" : "reasoning";
			return {
				...state,
				live: {
					...state.live,
					[message.sessionId]: { ...live, running: true, [key]: live[key] + message.delta },
				},
				runStates: { ...state.runStates, [message.sessionId]: "running" },
				...(state.current?.meta.id === message.sessionId
					? {
							current: {
								...state.current,
								running: true,
								live: { ...live, running: true, [key]: live[key] + message.delta },
							},
						}
					: {}),
			};
		}
		case "tool-output": {
			const live = state.live[message.sessionId] ?? EMPTY_LIVE;
			const nextLive: LiveState = {
				...live,
				toolOutputs: {
					...live.toolOutputs,
					[message.toolCallId]: (live.toolOutputs[message.toolCallId] ?? "") + message.delta,
				},
			};
			return { ...state, live: { ...state.live, [message.sessionId]: nextLive } };
		}
		case "retry": {
			const live = state.live[message.sessionId] ?? EMPTY_LIVE;
			return { ...state, live: { ...state.live, [message.sessionId]: { ...live, text: "", reasoning: "" } } };
		}
		case "subagent": {
			const existing = state.subagents[message.sessionId] ?? {};
			return {
				...state,
				subagents: {
					...state.subagents,
					[message.sessionId]: {
						...existing,
						[message.progress.toolCallId]: {
							steps: message.progress.steps,
							totalTokens: message.progress.totalTokens,
							elapsedMs: message.progress.elapsedMs,
						},
					},
				},
			};
		}
		case "run": {
			const live = state.live[message.sessionId] ?? EMPTY_LIVE;
			const ended = message.state === "idle" || message.state === "error";
			const nextLive: LiveState = ended
				? { ...live, running: false, paused: false, text: "", reasoning: "", toolOutputs: {} }
				: { ...live, running: message.state === "running", paused: message.state === "paused" };
			return {
				...state,
				runStates: { ...state.runStates, [message.sessionId]: message.state },
				live: { ...state.live, [message.sessionId]: nextLive },
				...(state.current?.meta.id === message.sessionId
					? {
							current: {
								...state.current,
								running: message.state === "running",
								live: nextLive,
							},
						}
					: {}),
				...(message.state === "error" && message.error !== undefined
					? { notices: pushNotice(state.notices, "error", message.error) }
					: {}),
			};
		}
		case "approval": {
			if (state.approvals.some((card) => card.id === message.card.id)) return state;
			return { ...state, approvals: [...state.approvals, message.card] };
		}
		case "approval-cleared":
			return { ...state, approvals: state.approvals.filter((card) => card.id !== message.id) };
		case "session-updated": {
			const sessions = upsertMeta(state.sessions, message.meta);
			return {
				...state,
				sessions,
				...(state.current?.meta.id === message.meta.id ? { current: { ...state.current, meta: message.meta } } : {}),
			};
		}
		case "session-pins":
			return { ...state, pinnedSessionIds: message.ids };
		case "sidebar-width":
			return { ...state, sidebarWidth: message.width };
		case "session-cleared": {
			const next = {
				...state,
				sessions: state.sessions.filter((meta) => meta.id !== message.sessionId),
				sessionsVersion: state.sessionsVersion + 1,
			};
			return state.current?.meta.id === message.sessionId
				? { ...newTaskState(next), ...resetHistory({ type: "new-task" }) }
				: next;
		}
		case "session-view": {
			if (state.current?.meta.id !== message.view.meta.id) return state;
			return {
				...state,
				current: message.view,
				live: { ...state.live, [message.view.meta.id]: message.view.live },
				sessions: upsertMeta(state.sessions, message.view.meta),
				runStates: { ...state.runStates, [message.view.meta.id]: message.view.running ? "running" : "idle" },
			};
		}
		case "sessions-changed":
			return { ...state, sessionsVersion: state.sessionsVersion + 1 };
		case "workspace":
			return { ...state, workspaceVersion: state.workspaceVersion + 1 };
		case "notice":
			return { ...state, notices: pushNotice(state.notices, message.level, message.message) };
		case "project":
			return state.project?.root === message.project.root ? updateWorkspace(state, message.project) : state;
		case "trust":
			return {
				...state,
				...(state.project === undefined ? {} : { project: { ...state.project, trust: message.trust } }),
			};
		case "queue": {
			const queued = message.items.length;
			return {
				...state,
				queue: { ...state.queue, [message.sessionId]: message.items },
				...(state.current?.meta.id === message.sessionId ? { current: { ...state.current, queued } } : {}),
			};
		}
		case "review": {
			const review: ReviewState = {
				runId: message.runId,
				state: message.state,
				...(message.report === undefined ? {} : { report: message.report }),
				...(message.error === undefined ? {} : { error: message.error }),
			};
			return { ...state, review };
		}
		case "window-state":
			return { ...state, windowMaximized: message.state.maximized };
	}
}

/** 追加导航记录；重复当前项不新增，已后退时丢弃前进分支。 */
function pushHistory(state: AppState, entry: HistoryEntry): Pick<AppState, "history" | "historyIndex"> {
	const current = state.history[state.historyIndex];
	if (current !== undefined && sameHistoryEntry(current, entry)) {
		return { history: state.history, historyIndex: state.historyIndex };
	}
	const history = [...state.history.slice(0, state.historyIndex + 1), entry];
	return { history, historyIndex: history.length - 1 };
}

/** 切换项目或删除当前会话后，导航历史收敛为单条入口。 */
function resetHistory(entry: HistoryEntry): Pick<AppState, "history" | "historyIndex"> {
	return { history: [entry], historyIndex: 0 };
}

/** 首次发送创建会话后，把草稿入口替换为新会话，避免后退回到已清空的草稿。 */
function enterCreatedSession(state: AppState, sessionId: string): Pick<AppState, "history" | "historyIndex"> {
	const current = state.history[state.historyIndex];
	if (current?.type === "new-task") {
		const history = [...state.history.slice(0, state.historyIndex), { type: "session" as const, sessionId }];
		return { history, historyIndex: history.length - 1 };
	}
	return pushHistory(state, { type: "session", sessionId });
}

function sameHistoryEntry(left: HistoryEntry, right: HistoryEntry): boolean {
	if (left.type !== right.type) return false;
	return left.type === "new-task" || (right.type === "session" && left.sessionId === right.sessionId);
}

function newTaskState(state: AppState): AppState {
	// 新任务草稿沿用上一会话的模型与推理强度，避免每次新建都回退到全局默认；
	// 审批档位与计划模式仍回默认，不隐式带入上一会话的高危设置。
	const seed = state.current === undefined ? {} : { model: state.current.model, effort: state.current.effort };
	return {
		...state,
		current: undefined,
		page: "chat",
		loadError: undefined,
		isNavigating: false,
		review: undefined,
		draft: createTaskDraft(seed),
		draftGeneration: state.draftGeneration + 1,
		draftRevision: 0,
		draftWorkspace: undefined,
	};
}

// 工作区信息与会话选择分离；配置推送不得覆盖用户正在编辑的新任务。
function updateWorkspace(state: AppState, project: ProjectSnapshot): AppState {
	const rootChanged = state.project?.root !== project.root;
	return {
		...state,
		project,
		models: project.models,
		app: appWithRecentProjects(state.app, project.recentProjects),
		...(rootChanged
			? {
					events: {},
					live: {},
					queue: {},
					subagents: {},
					approvals: [],
					runStates: {},
					review: undefined,
					workspaceVersion: state.workspaceVersion + 1,
				}
			: {}),
	};
}

function selectSession(state: AppState, view: SessionView): AppState {
	return {
		...state,
		current: view,
		loadError: undefined,
		live: { ...state.live, [view.meta.id]: view.live },
		sessions: upsertMeta(state.sessions, view.meta),
	};
}

function appWithRecentProjects(
	app: AppSnapshot | undefined,
	projects: readonly RecentProject[],
): AppSnapshot | undefined {
	if (app === undefined) return undefined;
	const unchanged =
		app.recentProjects.length === projects.length &&
		projects.every((project, index) => {
			const previous = app.recentProjects[index];
			return (
				previous?.root === project.root &&
				previous.name === project.name &&
				previous.lastOpenedAt === project.lastOpenedAt
			);
		});
	return unchanged ? app : { ...app, recentProjects: projects };
}

function themeFromSettings(settings: SettingsSnapshot | undefined): ThemeChoice | undefined {
	return settings?.config.ui.theme;
}

function pushNotice(notices: readonly Notice[], level: Notice["level"], message: string): readonly Notice[] {
	return [...notices.slice(-4), { id: ++noticeSequence, level, message }];
}

function upsertMeta(sessions: readonly SessionMeta[], meta: SessionMeta): readonly SessionMeta[] {
	const index = sessions.findIndex((entry) => entry.id === meta.id);
	if (index === -1) return [...sessions, meta];
	const next = [...sessions];
	next[index] = meta;
	return next;
}

function mergeEvents(existing: readonly EventRecord[], incoming: readonly EventRecord[]): readonly EventRecord[] {
	if (incoming.length === 0) return existing;
	const bySeq = new Map<number, EventRecord>();
	for (const event of existing) bySeq.set(event.seq, event);
	for (const event of incoming) bySeq.set(event.seq, event);
	return [...bySeq.values()].sort((left, right) => left.seq - right.seq);
}

export function trustOf(project: ProjectSnapshot | undefined): WorkspaceTrustView | undefined {
	return project?.trust;
}

interface AppContextValue {
	readonly state: AppState;
	readonly dispatch: Dispatch<Action>;
}

const AppContext = createContext<AppContextValue | undefined>(undefined);

export function AppProvider({ children }: { readonly children: ReactNode }): JSX.Element {
	const [state, dispatch] = useReducer(reducer, initialState);
	return <AppContext.Provider value={{ state, dispatch }}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
	const value = useContext(AppContext);
	if (value === undefined) throw new Error("useApp must be used inside AppProvider");
	return value;
}
