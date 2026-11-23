import { contextBridge, ipcRenderer } from "electron";

import { IPC, PUSH_CHANNEL, type DesktopBridge, type PushMessage, type RpcResult } from "../shared/contract.ts";

/** invoke 的薄封装；主进程统一返回 RpcResult，不在这里抛异常。 */
function invoke<T>(channel: string, ...args: unknown[]): Promise<RpcResult<T>> {
	return ipcRenderer.invoke(channel, ...args) as Promise<RpcResult<T>>;
}

const bridge: DesktopBridge = {
	appState: () => invoke(IPC.appState),
	openProjectDialog: () => invoke(IPC.appOpenProjectDialog),
	openProject: (path) => invoke(IPC.appOpenProject, path),
	selectProjectDialog: () => invoke(IPC.appSelectProjectDialog),
	createProjectDialog: (name) => invoke(IPC.appCreateProjectDialog, name),
	openProjectFolder: (root) => invoke(IPC.appOpenProjectFolder, root),
	openTerminal: (root) => invoke(IPC.appOpenTerminal, root),
	copyProjectPath: (root) => invoke(IPC.appCopyProjectPath, root),
	forgetProject: (root) => invoke(IPC.appForgetProject, root),
	prepareWorkspace: (target) => invoke(IPC.workspacePrepare, target),
	gitBranches: (root) => invoke(IPC.gitBranches, root),
	gitCheckout: (root, branch) => invoke(IPC.gitCheckout, root, branch),
	openExternal: (url) => invoke(IPC.appOpenExternal, url),
	windowMinimize: () => invoke(IPC.windowMinimize),
	windowToggleMaximize: () => invoke(IPC.windowToggleMaximize),
	windowClose: () => invoke(IPC.windowClose),
	windowState: () => invoke(IPC.windowState),
	windowSetTheme: (dark) => invoke(IPC.windowSetTheme, dark),
	sidebarSetWidth: (width) => invoke(IPC.sidebarSetWidth, width),

	sessionsList: (query) => invoke(IPC.sessionsList, query),
	sessionsCreate: (input) => invoke(IPC.sessionsCreate, input),
	sessionsActivate: (id) => invoke(IPC.sessionsActivate, id),
	sessionsRename: (id, title) => invoke(IPC.sessionsRename, id, title),
	sessionsArchive: (id, archived) => invoke(IPC.sessionsArchive, id, archived),
	sessionsDelete: (ids) => invoke(IPC.sessionsDelete, ids),
	sessionsRenameInTarget: (id, title, target) => invoke(IPC.sessionsRenameInTarget, id, title, target),
	sessionsArchiveInTarget: (id, archived, target) => invoke(IPC.sessionsArchiveInTarget, id, archived, target),
	sessionsDeleteInTarget: (ids, target) => invoke(IPC.sessionsDeleteInTarget, ids, target),
	sessionPin: (id, pinned) => invoke(IPC.sessionPin, id, pinned),
	sessionsFork: (id, uptoSeq) => invoke(IPC.sessionsFork, id, uptoSeq),
	sessionsExport: (id) => invoke(IPC.sessionsExport, id),
	sessionsReplay: (id) => invoke(IPC.sessionsReplay, id),
	sessionsEvents: (id, beforeSeq, limit) => invoke(IPC.sessionsEvents, id, beforeSeq, limit),
	messageFeedback: (sessionId, targetSeq, rating) => invoke(IPC.messageFeedback, sessionId, targetSeq, rating),
	sessionsChanges: (id) => invoke(IPC.sessionsChanges, id),
	sessionsChangeStats: (id) => invoke(IPC.sessionsChangeStats, id),
	sessionsCheckpoint: () => invoke(IPC.sessionsCheckpoint),
	sessionsRollback: () => invoke(IPC.sessionsRollback),
	sessionsRollbackTask: () => invoke(IPC.sessionsRollbackTask),
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
	settingsRenameProvider: (from, to) => invoke(IPC.settingsRenameProvider, from, to),
	settingsRevealSecret: (name) => invoke(IPC.settingsRevealSecret, name),
	settingsDiscoverModels: (input) => invoke(IPC.settingsDiscoverModels, input),
	settingsTestModel: (input) => invoke(IPC.settingsTestModel, input),
	settingsLookupModelMetadata: (id) => invoke(IPC.settingsLookupModelMetadata, id),
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
	mcpServerUpsert: (name, draft) => invoke(IPC.mcpServerUpsert, name, draft),
	mcpServerRemove: (name) => invoke(IPC.mcpServerRemove, name),
	mcpServerDetail: (name) => invoke(IPC.mcpServerDetail, name),
	mcpReload: () => invoke(IPC.mcpReload),

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
