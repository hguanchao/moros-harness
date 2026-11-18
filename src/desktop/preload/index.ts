import { contextBridge, ipcRenderer } from "electron";

import {
	IPC,
	PUSH_CHANNEL,
	type DesktopBridge,
	type PushMessage,
	type RpcResult,
} from "#src/desktop/shared/contract.ts";

/** invoke 的薄封装；主进程统一返回 RpcResult，不在这里抛异常。 */
function invoke<T>(channel: string, ...args: unknown[]): Promise<RpcResult<T>> {
	return ipcRenderer.invoke(channel, ...args) as Promise<RpcResult<T>>;
}

const bridge: DesktopBridge = {
	appState: () => invoke(IPC.appState),
	openProjectDialog: () => invoke(IPC.appOpenProjectDialog),
	openProject: (path) => invoke(IPC.appOpenProject, path),
	openExternal: (url) => invoke(IPC.appOpenExternal, url),
	windowMinimize: () => invoke(IPC.windowMinimize),
	windowToggleMaximize: () => invoke(IPC.windowToggleMaximize),
	windowClose: () => invoke(IPC.windowClose),
	windowState: () => invoke(IPC.windowState),
	windowSetTheme: (dark) => invoke(IPC.windowSetTheme, dark),

	sessionsList: (query) => invoke(IPC.sessionsList, query),
	sessionsCreate: () => invoke(IPC.sessionsCreate),
	sessionsActivate: (id) => invoke(IPC.sessionsActivate, id),
	sessionsRename: (id, title) => invoke(IPC.sessionsRename, id, title),
	sessionsArchive: (id, archived) => invoke(IPC.sessionsArchive, id, archived),
	sessionsDelete: (ids) => invoke(IPC.sessionsDelete, ids),
	sessionsFork: (id, uptoSeq) => invoke(IPC.sessionsFork, id, uptoSeq),
	sessionsExport: (id) => invoke(IPC.sessionsExport, id),
	sessionsReplay: (id) => invoke(IPC.sessionsReplay, id),
	sessionsEvents: (id, beforeSeq, limit) => invoke(IPC.sessionsEvents, id, beforeSeq, limit),
	sessionsChanges: (id) => invoke(IPC.sessionsChanges, id),
	sessionsCheckpoint: () => invoke(IPC.sessionsCheckpoint),
	sessionsRollback: () => invoke(IPC.sessionsRollback),
	sessionsRestore: (id) => invoke(IPC.sessionsRestore, id),
	sessionsCompact: () => invoke(IPC.sessionsCompact),
	sessionsReview: (prompt) => invoke(IPC.sessionsReview, prompt),

	chatSend: (input) => invoke(IPC.chatSend, input),
	chatAbort: () => invoke(IPC.chatAbort),
	chatPause: () => invoke(IPC.chatPause),
	chatResume: () => invoke(IPC.chatResume),
	chatLive: (sessionId) => invoke(IPC.chatLive, sessionId),
	chatClearQueue: () => invoke(IPC.chatClearQueue),
	approvalRespond: (id, decision) => invoke(IPC.approvalRespond, id, decision),

	workspaceList: (path, includeHidden) => invoke(IPC.workspaceList, path, includeHidden),
	workspaceRead: (path) => invoke(IPC.workspaceRead, path),
	workspaceReadBinary: (path) => invoke(IPC.workspaceReadBinary, path),
	diffGet: (seq) => invoke(IPC.diffGet, seq),
	traceGet: (sessionId) => invoke(IPC.traceGet, sessionId),

	settingsGet: () => invoke(IPC.settingsGet),
	settingsUpdate: (patch) => invoke(IPC.settingsUpdate, patch),
	settingsUpsertProvider: (name, draft) => invoke(IPC.settingsUpsertProvider, name, draft),
	settingsDeleteProvider: (name) => invoke(IPC.settingsDeleteProvider, name),
	settingsRevealSecret: (name) => invoke(IPC.settingsRevealSecret, name),
	modelsList: () => invoke(IPC.modelsList),
	configSummary: () => invoke(IPC.configSummary),

	sessionSelectModel: (provider, model) => invoke(IPC.sessionSelectModel, provider, model),
	sessionSelectEffort: (effort) => invoke(IPC.sessionSelectEffort, effort),
	sessionSelectApproval: (mode) => invoke(IPC.sessionSelectApproval, mode),
	sessionSetPlan: (enabled) => invoke(IPC.sessionSetPlan, enabled),
	skillsList: () => invoke(IPC.skillsList),
	trustAccept: (remember) => invoke(IPC.trustAccept, remember),
	trustDeny: () => invoke(IPC.trustDeny),
	mcpStatus: () => invoke(IPC.mcpStatus),
	mcpReconnect: (name) => invoke(IPC.mcpReconnect, name),
	mcpHealth: () => invoke(IPC.mcpHealth),

	imagesPick: () => invoke(IPC.imagesPick),
	imagesFromBytes: (bytes, mediaType) => invoke(IPC.imagesFromBytes, bytes, mediaType),
	imagesFromUrl: (url) => invoke(IPC.imagesFromUrl, url),

	onPush(listener) {
		const wrapped = (_event: Electron.IpcRendererEvent, message: PushMessage): void => listener(message);
		ipcRenderer.on(PUSH_CHANNEL, wrapped);
		return () => ipcRenderer.removeListener(PUSH_CHANNEL, wrapped);
	},
};

contextBridge.exposeInMainWorld("moros", bridge);
