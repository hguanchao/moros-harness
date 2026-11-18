import { createContext, useContext, useReducer, type Dispatch, type JSX, type ReactNode } from "react";

import type { SettingsSnapshot } from "#src/core/config/settings.ts";
import type { EventRecord } from "#src/core/events/schema.ts";
import type { ModelCatalog } from "#src/core/core.ts";
import type { SessionMeta } from "#src/core/session/session-manager.ts";
import type {
	AppSnapshot,
	ApprovalCard,
	LiveState,
	ProjectSnapshot,
	PushMessage,
	QueuedMessage,
	SessionView,
	WorkspaceTrustView,
} from "#src/desktop/shared/contract.ts";

export type Page = "chat" | "files" | "changes" | "trace" | "sessions" | "settings";
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
	readonly app: AppSnapshot | undefined;
	readonly project: ProjectSnapshot | undefined;
	readonly page: Page;
	readonly sidebarOpen: boolean;
	readonly sessions: readonly SessionMeta[];
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
	readonly resolvedTheme: ResolvedTheme;
	readonly workspaceVersion: number;
	readonly review: ReviewState | undefined;
	readonly windowMaximized: boolean;
}

export type Action =
	| { readonly type: "init"; readonly app: AppSnapshot; readonly settings?: SettingsSnapshot }
	| { readonly type: "open-project"; readonly project: ProjectSnapshot }
	| { readonly type: "project"; readonly project: ProjectSnapshot }
	| { readonly type: "sessions"; readonly items: readonly SessionMeta[] }
	| { readonly type: "session"; readonly view: SessionView }
	| {
			readonly type: "events";
			readonly sessionId: string;
			readonly events: readonly EventRecord[];
			readonly mode: "replace" | "prepend";
	  }
	| {
			readonly type: "live-snapshot";
			readonly sessionId: string;
			readonly live: LiveState;
			readonly queued: readonly QueuedMessage[];
	  }
	| { readonly type: "push"; readonly message: PushMessage }
	| { readonly type: "page"; readonly page: Page }
	| { readonly type: "sidebar"; readonly open: boolean }
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
	app: undefined,
	project: undefined,
	current: undefined,
	settings: undefined,
	review: undefined,
	page: "chat",
	sidebarOpen: true,
	sessions: [],
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
	resolvedTheme: "dark",
	workspaceVersion: 0,
	windowMaximized: false,
};

let noticeSequence = 0;

export function reducer(state: AppState, action: Action): AppState {
	switch (action.type) {
		case "init": {
			const project = action.app.project;
			const settings = action.settings ?? state.settings;
			return {
				...state,
				ready: true,
				loadError: undefined,
				app: action.app,
				...(project === undefined ? {} : { project }),
				settings,
				theme: themeFromSettings(settings) ?? state.theme,
				models: project?.models ?? state.models,
				current: project?.session ?? state.current,
				...(project?.session === undefined
					? {}
					: {
							live: { ...state.live, [project.session.meta.id]: project.session.live },
						}),
			};
		}
		case "open-project": {
			return {
				...state,
				project: action.project,
				models: action.project.models,
				current: action.project.session,
				sessions: [],
				sessionsVersion: state.sessionsVersion + 1,
				events: {},
				live: {},
				queue: {},
				subagents: {},
				approvals: [],
				runStates: {},
				workspaceVersion: state.workspaceVersion + 1,
				page: "chat",
				ready: true,
			};
		}
		case "project": {
			const rootChanged = state.project?.root !== action.project.root;
			return {
				...state,
				project: action.project,
				models: action.project.models,
				...(rootChanged
					? { events: {}, live: {}, queue: {}, subagents: {}, current: action.project.session }
					: action.project.session === undefined
						? {}
						: { current: action.project.session }),
			};
		}
		case "sessions":
			return { ...state, sessions: action.items };
		case "session": {
			const id = action.view.meta.id;
			return {
				...state,
				current: action.view,
				live: { ...state.live, [id]: action.view.live },
				sessions: upsertMeta(state.sessions, action.view.meta),
			};
		}
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
		case "settings":
			return {
				...state,
				settings: action.settings,
				theme: action.settings.config.ui.theme,
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
		case "project": {
			const rootChanged = state.project?.root !== message.project.root;
			return {
				...state,
				project: message.project,
				models: message.project.models,
				...(rootChanged ? { events: {}, live: {}, queue: {}, current: message.project.session } : {}),
			};
		}
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
