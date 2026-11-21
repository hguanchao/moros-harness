import { useCallback } from "react";

import type {
	ProjectRef,
	ProjectSnapshot,
	SessionContext,
	SessionCreateInput,
	SessionView,
	WorkspaceTarget,
} from "../shared/contract.ts";
import { call, errorMessage } from "../api/api.ts";
import { useApp, type Page } from "../store/state.tsx";
import { workspaceTargetsMatch } from "../utils/workspace.ts";

let navigationEpoch = 0;
let sessionRefreshEpoch = 0;

/** 当前显式会话导航代次；启动恢复用它判断用户是否已转到新任务，读取不会发起导航。 */
export function currentNavigationEpoch(): number {
	return navigationEpoch;
}

/** 共用桌面动作；异步错误向调用方传递，过时的导航或首发结果不覆盖后续用户操作。 */
export interface DesktopActions {
	readonly openProjectDialog: () => Promise<void>;
	readonly openProject: (root: string) => Promise<void>;
	readonly newTask: () => void;
	/** 进入新任务草稿并关联明确项目归属（null 表示内部任务根），保留当前已输入内容。 */
	readonly newTaskInProject: (project: ProjectRef | null) => void;
	readonly selectProjectDialog: () => Promise<void>;
	readonly createProjectDialog: (name: string) => Promise<boolean>;
	readonly prepareTask: (target: WorkspaceTarget, generation: number) => Promise<ProjectSnapshot | undefined>;
	readonly createTask: (input: SessionCreateInput, generation: number) => Promise<SessionContext | undefined>;
	readonly activateSession: (id: string) => Promise<void>;
	readonly goBack: () => Promise<void>;
	readonly goForward: () => Promise<void>;
	readonly refreshSessions: () => Promise<void>;
	readonly setPage: (page: Page) => void;
	readonly hydrate: (view: SessionView, epoch?: number) => Promise<void>;
}

/**
 * 渲染层共用的任务动作；项目关联、草稿与实际执行工作区保持分离。
 * @returns 稳定回调组成的动作集合；RPC 错误由界面统一展示。
 */
export function useDesktopActions(): DesktopActions {
	const { state, dispatch } = useApp();
	const app = state.app;
	const generation = state.draftGeneration;

	const hydrateEvents = useCallback(
		async (view: SessionView, epoch: number): Promise<void> => {
			try {
				const [events, live] = await Promise.all([
					call(window.moros.sessionsEvents(view.meta.id, undefined, 200)),
					call(window.moros.chatLive(view.meta.id)),
				]);
				if (epoch !== navigationEpoch) return;
				dispatch({ type: "events", sessionId: view.meta.id, events });
				dispatch({ type: "live-snapshot", sessionId: view.meta.id, live: live.live, queued: live.queued });
			} catch (error) {
				if (epoch === navigationEpoch) throw error;
			}
		},
		[dispatch],
	);

	const loadSession = useCallback(
		async (view: SessionView, epoch: number): Promise<void> => {
			if (epoch !== navigationEpoch) return;
			dispatch({ type: "session", view });
			await hydrateEvents(view, epoch);
		},
		[dispatch, hydrateEvents],
	);

	const hydrate = useCallback(
		async (view: SessionView, epoch = navigationEpoch): Promise<void> => {
			await hydrateEvents(view, epoch);
		},
		[hydrateEvents],
	);

	const refreshSessions = useCallback(async (): Promise<void> => {
		if (app === undefined) return;
		const epoch = ++sessionRefreshEpoch;
		const targets: WorkspaceTarget[] = [
			{ kind: "tasks" },
			...app.recentProjects.map((project): WorkspaceTarget => ({ kind: "project", root: project.root })),
		];
		const pages = await Promise.allSettled(
			targets.map((target) => call(window.moros.sessionsList({ target, limit: 100, includeArchived: false }))),
		);
		if (epoch !== sessionRefreshEpoch) return;
		const items = pages.flatMap((page, index) => {
			if (page.status === "fulfilled") return page.value.items;
			const label = index === 0 ? "任务" : (app.recentProjects[index - 1]?.name ?? "项目");
			dispatch({ type: "notice", level: "warn", message: `无法加载${label}会话：${errorMessage(page.reason)}` });
			return [];
		});
		const sessions = new Map(items.map((meta) => [meta.id, meta]));
		dispatch({ type: "sessions", items: [...sessions.values()] });
	}, [app, dispatch]);

	const openProject = useCallback(
		async (root: string): Promise<void> => {
			const epoch = ++navigationEpoch;
			dispatch({ type: "navigation-loading", isLoading: true });
			try {
				const project = await call(window.moros.openProject(root));
				if (epoch !== navigationEpoch) return;
				dispatch({ type: "open-project", project });
				if (project.session !== undefined) await loadSession(project.session, epoch);
			} finally {
				if (epoch === navigationEpoch) dispatch({ type: "navigation-loading", isLoading: false });
			}
		},
		[dispatch, loadSession],
	);

	const openProjectDialog = useCallback(async (): Promise<void> => {
		const epoch = ++navigationEpoch;
		dispatch({ type: "navigation-loading", isLoading: true });
		try {
			const project = await call(window.moros.openProjectDialog());
			if (project === null || epoch !== navigationEpoch) return;
			dispatch({ type: "open-project", project });
			if (project.session !== undefined) await loadSession(project.session, epoch);
		} finally {
			if (epoch === navigationEpoch) dispatch({ type: "navigation-loading", isLoading: false });
		}
	}, [dispatch, loadSession]);

	const newTask = useCallback((): void => {
		++navigationEpoch;
		dispatch({ type: "new-task" });
	}, [dispatch]);

	const newTaskInProject = useCallback(
		(project: ProjectRef | null): void => {
			++navigationEpoch;
			dispatch({ type: "new-task" });
			dispatch({ type: "draft-project", project });
		},
		[dispatch],
	);

	const selectProjectDialog = useCallback(async (): Promise<void> => {
		const selection = await call(window.moros.selectProjectDialog());
		if (selection !== null) dispatch({ type: "project-selected", selection, generation });
	}, [dispatch, generation]);

	const createProjectDialog = useCallback(
		async (name: string): Promise<boolean> => {
			const selection = await call(window.moros.createProjectDialog(name));
			if (selection === null) return false;
			dispatch({ type: "project-selected", selection, generation });
			return true;
		},
		[dispatch, generation],
	);

	const prepareTask = useCallback(
		async (target: WorkspaceTarget, draftGeneration: number): Promise<ProjectSnapshot | undefined> => {
			const epoch = navigationEpoch;
			const project = await call(window.moros.prepareWorkspace(target));
			if (epoch !== navigationEpoch) return undefined;
			dispatch({ type: "prepare-workspace", project, generation: draftGeneration });
			return project;
		},
		[dispatch],
	);

	const createTask = useCallback(
		async (input: SessionCreateInput, draftGeneration: number): Promise<SessionContext | undefined> => {
			const epoch = navigationEpoch;
			const context = await call(window.moros.sessionsCreate(input));
			if (epoch !== navigationEpoch) return undefined;
			if (!workspaceTargetsMatch(context.project.target, input.target, app?.platform ?? "win32")) {
				throw new Error("任务的工作目录不一致，请重新发送");
			}
			dispatch({ type: "session-created", context, generation: draftGeneration });
			return context;
		},
		[app?.platform, dispatch],
	);

	const activateSession = useCallback(
		async (id: string): Promise<void> => {
			const epoch = ++navigationEpoch;
			dispatch({ type: "navigation-loading", isLoading: true });
			try {
				const context = await call(window.moros.sessionsActivate(id));
				if (epoch !== navigationEpoch) return;
				dispatch({ type: "open-project", project: context.project, keepHistory: true });
				dispatch({ type: "history-entry", entry: { type: "session", sessionId: context.session.meta.id } });
				await loadSession(context.session, epoch);
			} finally {
				if (epoch === navigationEpoch) dispatch({ type: "navigation-loading", isLoading: false });
			}
		},
		[dispatch, loadSession],
	);

	const travel = useCallback(
		async (delta: -1 | 1): Promise<void> => {
			const index = state.historyIndex + delta;
			const entry = state.history[index];
			if (entry === undefined) return;
			if (entry.type === "new-task") {
				++navigationEpoch;
				dispatch({ type: "view-new-task" });
				dispatch({ type: "history-index", index });
				return;
			}
			const epoch = ++navigationEpoch;
			dispatch({ type: "navigation-loading", isLoading: true });
			try {
				const context = await call(window.moros.sessionsActivate(entry.sessionId));
				if (epoch !== navigationEpoch) return;
				dispatch({ type: "open-project", project: context.project, keepHistory: true });
				dispatch({ type: "history-index", index });
				await loadSession(context.session, epoch);
			} finally {
				if (epoch === navigationEpoch) dispatch({ type: "navigation-loading", isLoading: false });
			}
		},
		[state.history, state.historyIndex, dispatch, loadSession],
	);

	const goBack = useCallback((): Promise<void> => travel(-1), [travel]);
	const goForward = useCallback((): Promise<void> => travel(1), [travel]);

	const setPage = useCallback((page: Page): void => dispatch({ type: "page", page }), [dispatch]);

	return {
		openProjectDialog,
		openProject,
		newTask,
		newTaskInProject,
		selectProjectDialog,
		createProjectDialog,
		prepareTask,
		createTask,
		activateSession,
		goBack,
		goForward,
		refreshSessions,
		setPage,
		hydrate,
	};
}
