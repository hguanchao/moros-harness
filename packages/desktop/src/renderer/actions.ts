import { useCallback } from "react";

import type { SessionView } from "../shared/contract.ts";
import { call } from "./api.ts";
import { useApp, type Page } from "./state.tsx";

let navigationEpoch = 0;

export interface DesktopActions {
	readonly openProjectDialog: () => Promise<void>;
	readonly openProject: (root: string) => Promise<void>;
	readonly createSession: () => Promise<void>;
	readonly activateSession: (id: string) => Promise<void>;
	readonly refreshSessions: () => Promise<void>;
	readonly setPage: (page: Page) => void;
	readonly hydrate: (view: SessionView) => Promise<void>;
}

/** 渲染层共用的会话动作：切页、建会话、打开项目都统一走这里，避免各页各写一份加载顺序。 */
export function useDesktopActions(): DesktopActions {
	const { dispatch } = useApp();

	const loadSession = useCallback(
		async (view: SessionView, epoch?: number): Promise<void> => {
			dispatch({ type: "session", view });
			const [events, live] = await Promise.all([
				call(window.moros.sessionsEvents(view.meta.id, undefined, 200)),
				call(window.moros.chatLive(view.meta.id)),
			]);
			if (epoch !== undefined && epoch !== navigationEpoch) return;
			dispatch({ type: "events", sessionId: view.meta.id, events, mode: "replace" });
			dispatch({
				type: "live-snapshot",
				sessionId: view.meta.id,
				live: live.live,
				queued: live.queued,
			});
		},
		[dispatch],
	);

	const hydrate = useCallback(
		async (view: SessionView): Promise<void> => {
			await loadSession(view);
		},
		[loadSession],
	);

	const refreshSessions = useCallback(async (): Promise<void> => {
		const page = await call(window.moros.sessionsList({ limit: 100 }));
		dispatch({ type: "sessions", items: page.items });
	}, [dispatch]);

	const openProject = useCallback(
		async (root: string): Promise<void> => {
			const epoch = ++navigationEpoch;
			const project = await call(window.moros.openProject(root));
			if (epoch !== navigationEpoch) return;
			dispatch({ type: "open-project", project });
			if (project.session !== undefined) await loadSession(project.session, epoch);
			if (epoch !== navigationEpoch) return;
			await refreshSessions();
		},
		[dispatch, loadSession, refreshSessions],
	);

	const openProjectDialog = useCallback(async (): Promise<void> => {
		const epoch = ++navigationEpoch;
		const project = await call(window.moros.openProjectDialog());
		if (project === null || epoch !== navigationEpoch) return;
		dispatch({ type: "open-project", project });
		if (project.session !== undefined) await loadSession(project.session, epoch);
		if (epoch !== navigationEpoch) return;
		await refreshSessions();
	}, [dispatch, loadSession, refreshSessions]);

	const createSession = useCallback(async (): Promise<void> => {
		const epoch = ++navigationEpoch;
		const view = await call(window.moros.sessionsCreate());
		if (epoch !== navigationEpoch) return;
		await loadSession(view, epoch);
		if (epoch !== navigationEpoch) return;
		await refreshSessions();
		dispatch({ type: "page", page: "chat" });
	}, [dispatch, loadSession, refreshSessions]);

	const activateSession = useCallback(
		async (id: string): Promise<void> => {
			const epoch = ++navigationEpoch;
			const view = await call(window.moros.sessionsActivate(id));
			if (epoch !== navigationEpoch) return;
			await loadSession(view, epoch);
			if (epoch !== navigationEpoch) return;
			dispatch({ type: "page", page: "chat" });
		},
		[dispatch, loadSession],
	);

	const setPage = useCallback(
		(page: Page): void => {
			dispatch({ type: "page", page });
		},
		[dispatch],
	);

	return {
		openProjectDialog,
		openProject,
		createSession,
		activateSession,
		refreshSessions,
		setPage,
		hydrate,
	};
}
