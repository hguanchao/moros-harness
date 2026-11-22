import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";

import type { DiscoverModelsRequest, TestModelRequest } from "@moros/core/config/model-discovery.ts";
import { SettingsPatchSchema } from "@moros/core/config/settings.ts";
import { readFileBytes, readTextFile } from "@moros/core/workspace/files.ts";
import { SessionBusyError } from "@moros/core/session/session-lease.ts";
import type { ApprovalDecision } from "@moros/core/harness/types.ts";
import type { ProviderDraft } from "@moros/core/config/settings.ts";
import type { DesktopHost } from "./core-host.ts";
import {
	IPC,
	type RpcError,
	type RpcResult,
	type SessionCreateInput,
	type SessionListQuery,
	type WindowState,
	type WorkspaceTarget,
} from "../shared/contract.ts";
import { DesktopGitError } from "./_git.ts";
import { DesktopWorkspaceError } from "./_workspace.ts";

const WorkspaceTargetSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("tasks") }).strict(),
	z.object({ kind: z.literal("project"), root: z.string().min(1).max(4096) }).strict(),
]);
const ReasoningEffortSchema = z.enum(["off", "minimal", "low", "medium", "high", "max"]);
const ApprovalModeSchema = z.enum(["ask", "auto", "yolo"]);

const SessionCreateInputSchema = z
	.object({
		target: WorkspaceTargetSchema,
		model: z
			.object({ provider: z.string().min(1).max(200), model: z.string().min(1).max(500) })
			.strict()
			.optional(),
		effort: ReasoningEffortSchema.optional(),
		approval: ApprovalModeSchema.optional(),
		plan: z.boolean().optional(),
	})
	.strict()
	.transform((input): SessionCreateInput => ({
		target: input.target,
		...(input.model === undefined ? {} : { model: input.model }),
		...(input.effort === undefined ? {} : { effort: input.effort }),
		...(input.approval === undefined ? {} : { approval: input.approval }),
		...(input.plan === undefined ? {} : { plan: input.plan }),
	}));

const SessionListQuerySchema = z
	.object({
		target: WorkspaceTargetSchema.optional(),
		query: z.string().max(200).optional(),
		includeArchived: z.boolean().optional(),
		cursor: z.number().int().nonnegative().optional(),
		limit: z.number().int().min(1).max(100).optional(),
	})
	.strict();

const ChatSendSchema = z
	.object({
		sessionId: z.string().min(1).max(200),
		text: z.string().max(200_000),
		imageIds: z.array(z.string().max(100)).max(16).optional(),
	})
	.strict();

const TraceQuerySchema = z.string().min(1).max(200).optional();

const DiscoverModelsSchema = z
	.object({
		api: z.enum(["anthropic-messages", "chat-completions", "responses"]),
		baseUrl: z.string().min(1).max(4096),
		apiKey: z.string().max(8192).optional(),
		providerName: z.string().min(1).max(100).optional(),
	})
	.strict()
	.transform((input): DiscoverModelsRequest => ({
		api: input.api,
		baseUrl: input.baseUrl,
		...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
		...(input.providerName === undefined ? {} : { providerName: input.providerName }),
	}));

const TestModelSchema = z
	.object({
		api: z.enum(["anthropic-messages", "chat-completions", "responses"]),
		baseUrl: z.string().min(1).max(4096),
		modelId: z.string().min(1).max(500),
		apiKey: z.string().max(8192).optional(),
		providerName: z.string().min(1).max(100).optional(),
		timeoutMs: z.number().int().min(1000).max(300_000).optional(),
		httpProxy: z.string().max(2048).optional(),
	})
	.strict()
	.transform((input): TestModelRequest => ({
		api: input.api,
		baseUrl: input.baseUrl,
		modelId: input.modelId,
		...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
		...(input.providerName === undefined ? {} : { providerName: input.providerName }),
		...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
		...(input.httpProxy === undefined ? {} : { httpProxy: input.httpProxy }),
	}));

/**
 * 注册渲染进程可调用的全部方法。
 *
 * 每个入口先校验发送方与参数；业务错误转成稳定的 RpcError，而不是把异常对象抛过 IPC。
 * 渲染进程没有 Node 权限，所有能力都只能走这里列出的动作。
 */
export function registerIpc(host: DesktopHost, getWindow: () => BrowserWindow | undefined): void {
	handle(IPC.appState, getWindow, z.tuple([]), () => host.initialize());
	handle(IPC.appOpenProjectDialog, getWindow, z.tuple([]), () => host.openProjectDialog());
	handle(IPC.appOpenProject, getWindow, z.tuple([z.string().min(1).max(4096)]), ([path]) => host.openProject(path));
	handle(IPC.appSelectProjectDialog, getWindow, z.tuple([]), () => host.selectProjectDialog());
	handle(IPC.appCreateProjectDialog, getWindow, z.tuple([z.string().min(1).max(255)]), ([name]) =>
		host.createProjectDialog(name),
	);
	handle(IPC.appOpenProjectFolder, getWindow, z.tuple([z.string().min(1).max(4096)]), ([root]) =>
		host.openProjectFolder(root),
	);
	handle(IPC.appOpenTerminal, getWindow, z.tuple([z.string().min(1).max(4096)]), ([root]) => host.openTerminal(root));
	handle(IPC.appCopyProjectPath, getWindow, z.tuple([z.string().min(1).max(4096)]), ([root]) =>
		host.copyProjectPath(root),
	);
	handle(IPC.appForgetProject, getWindow, z.tuple([z.string().min(1).max(4096)]), ([root]) => host.forgetProject(root));
	handle(IPC.workspacePrepare, getWindow, z.tuple([WorkspaceTargetSchema]), ([target]) =>
		host.prepareWorkspace(target),
	);
	handle(IPC.gitBranches, getWindow, z.tuple([z.string().min(1).max(4096)]), ([root]) => host.gitBranches(root));
	handle(
		IPC.gitCheckout,
		getWindow,
		z.tuple([z.string().min(1).max(4096), z.string().min(1).max(255)]),
		([root, branch]) => host.checkoutBranch(root, branch),
	);
	handle(IPC.appOpenExternal, getWindow, z.tuple([z.string().url().max(4096)]), ([url]) => host.openExternal(url));

	handle(IPC.windowMinimize, getWindow, z.tuple([]), () => {
		getWindow()?.minimize();
	});
	handle(IPC.windowToggleMaximize, getWindow, z.tuple([]), () => {
		const window = getWindow();
		if (window === undefined) return;
		if (window.isMaximized()) window.unmaximize();
		else window.maximize();
	});
	handle(IPC.windowClose, getWindow, z.tuple([]), () => {
		getWindow()?.close();
	});
	handle(IPC.windowState, getWindow, z.tuple([]), () => windowState(getWindow()));
	handle(IPC.windowSetTheme, getWindow, z.tuple([z.boolean()]), ([dark]) => {
		const window = getWindow();
		if (window === undefined || window.isDestroyed()) return;
		window.setBackgroundColor(dark ? "#202020" : "#ebebeb");
	});
	handle(IPC.sidebarSetWidth, getWindow, z.tuple([z.number().int()]), ([width]) => host.setSidebarWidth(width));

	handle(IPC.sessionsList, getWindow, z.tuple([SessionListQuerySchema]), ([query]) =>
		host.listSessions(query as SessionListQuery),
	);
	handle(IPC.sessionsCreate, getWindow, z.tuple([SessionCreateInputSchema]), ([input]) => host.createSession(input));
	handle(IPC.sessionsActivate, getWindow, z.tuple([z.string().min(1).max(200)]), ([id]) => host.activateSession(id));
	handle(
		IPC.sessionsRename,
		getWindow,
		z.tuple([z.string().min(1).max(200), z.string().min(1).max(200)]),
		([id, title]) => host.renameSession(id, title),
	);
	handle(IPC.sessionsArchive, getWindow, z.tuple([z.string().min(1).max(200), z.boolean()]), ([id, archived]) =>
		host.archiveSession(id, archived),
	);
	handle(IPC.sessionsDelete, getWindow, z.tuple([z.array(z.string().min(1).max(200)).max(100)]), ([ids]) =>
		host.deleteSessions(ids),
	);
	handle(
		IPC.sessionsRenameInTarget,
		getWindow,
		z.tuple([z.string().min(1).max(200), z.string().min(1).max(200), WorkspaceTargetSchema]),
		([id, title, target]) => host.renameSessionInTarget(id, title, target as WorkspaceTarget),
	);
	handle(
		IPC.sessionsArchiveInTarget,
		getWindow,
		z.tuple([z.string().min(1).max(200), z.boolean(), WorkspaceTargetSchema]),
		([id, archived, target]) => host.archiveSessionInTarget(id, archived, target as WorkspaceTarget),
	);
	handle(
		IPC.sessionsDeleteInTarget,
		getWindow,
		z.tuple([z.array(z.string().min(1).max(200)).max(100), WorkspaceTargetSchema]),
		([ids, target]) => host.deleteSessionsInTarget(ids, target as WorkspaceTarget),
	);
	handle(IPC.sessionPin, getWindow, z.tuple([z.string().min(1).max(200), z.boolean()]), ([id, pinned]) =>
		host.pinSession(id, pinned),
	);
	handle(
		IPC.sessionsFork,
		getWindow,
		z.tuple([z.string().min(1).max(200), z.number().int().positive().optional()]),
		([id, uptoSeq]) => host.forkSession(id, uptoSeq),
	);
	handle(IPC.sessionsExport, getWindow, z.tuple([z.string().min(1).max(200)]), ([id]) => host.exportSession(id));
	handle(IPC.sessionsReplay, getWindow, z.tuple([z.string().min(1).max(200)]), ([id]) => host.replaySession(id));
	handle(
		IPC.sessionsEvents,
		getWindow,
		z.tuple([
			z.string().min(1).max(200),
			z.number().int().positive().optional(),
			z.number().int().min(1).max(500).optional(),
		]),
		([id, beforeSeq, limit]) => host.eventsPage(id, beforeSeq, limit),
	);
	handle(IPC.sessionsChanges, getWindow, z.tuple([z.string().min(1).max(200).optional()]), ([id]) =>
		host.sessionChanges(id),
	);
	handle(IPC.sessionsCheckpoint, getWindow, z.tuple([]), () => host.checkpoint());
	handle(IPC.sessionsRollback, getWindow, z.tuple([]), () => host.rollbackStep());
	handle(IPC.sessionsRestore, getWindow, z.tuple([z.string().min(1).max(200)]), ([id]) => host.restoreCheckpoint(id));
	handle(IPC.sessionsCompact, getWindow, z.tuple([]), () => host.compactSession());
	handle(IPC.sessionsReview, getWindow, z.tuple([z.string().max(20_000)]), ([prompt]) => host.reviewSession(prompt));

	handle(IPC.chatSend, getWindow, z.tuple([ChatSendSchema]), ([input]) =>
		host.send({
			sessionId: input.sessionId,
			text: input.text,
			...(input.imageIds === undefined ? {} : { imageIds: input.imageIds }),
		}),
	);
	handle(IPC.chatAbort, getWindow, z.tuple([]), () => host.abort());
	handle(IPC.chatPause, getWindow, z.tuple([]), () => host.pause());
	handle(IPC.chatResume, getWindow, z.tuple([]), () => host.resume());
	handle(IPC.chatLive, getWindow, z.tuple([z.string().min(1).max(200).optional()]), ([sessionId]) =>
		host.liveState(sessionId),
	);
	handle(IPC.chatClearQueue, getWindow, z.tuple([]), () => host.clearQueue());
	handle(
		IPC.approvalRespond,
		getWindow,
		z.tuple([z.string().min(1).max(200), z.enum(["allow", "deny", "allow-session"])]),
		([id, decision]) => {
			host.respondApproval(id, decision as ApprovalDecision);
		},
	);

	handle(
		IPC.workspaceList,
		getWindow,
		z.tuple([z.string().max(4096), z.boolean().optional()]),
		([path, includeHidden]) => host.workspaceList(path, includeHidden),
	);
	handle(IPC.workspaceRead, getWindow, z.tuple([z.string().min(1).max(4096)]), async ([path]) => {
		return readTextFile(host.workspaceRoot(), path);
	});
	handle(IPC.workspaceReadBinary, getWindow, z.tuple([z.string().min(1).max(4096)]), async ([path]) => {
		const result = await readFileBytes(host.workspaceRoot(), path, { maxBytes: 2 * 1024 * 1024 });
		const mime = mimeOf(path);
		return {
			path: result.path,
			bytes: result.bytes,
			mime,
			dataUrl: `data:${mime};base64,${result.data.toString("base64")}`,
			truncated: result.truncated,
		};
	});
	handle(IPC.diffGet, getWindow, z.tuple([z.number().int().positive()]), ([seq]) => host.diff(seq));
	handle(IPC.traceGet, getWindow, z.tuple([TraceQuerySchema]), ([sessionId]) => host.trace(sessionId));

	handle(IPC.settingsGet, getWindow, z.tuple([]), () => host.settings());
	handle(IPC.settingsUpdate, getWindow, z.tuple([z.unknown()]), ([patch]) => {
		const parsed = SettingsPatchSchema.parse(patch);
		return host.updateSettings(parsed);
	});
	handle(IPC.settingsUpsertProvider, getWindow, z.tuple([z.string().min(1).max(100), z.unknown()]), ([name, draft]) =>
		host.upsertProvider(name, draft as ProviderDraft),
	);
	handle(IPC.settingsDeleteProvider, getWindow, z.tuple([z.string().min(1).max(100)]), ([name]) =>
		host.deleteProvider(name),
	);
	handle(
		IPC.settingsRenameProvider,
		getWindow,
		z.tuple([z.string().min(1).max(100), z.string().min(1).max(100)]),
		([from, to]) => host.renameProvider(from, to),
	);
	handle(IPC.settingsRevealSecret, getWindow, z.tuple([z.string().min(1).max(100)]), ([name]) =>
		host.revealSecret(name),
	);
	handle(IPC.settingsDiscoverModels, getWindow, z.tuple([DiscoverModelsSchema]), ([input]) =>
		host.discoverModels(input),
	);
	handle(IPC.settingsTestModel, getWindow, z.tuple([TestModelSchema]), ([input]) => host.testModel(input));
	handle(IPC.settingsLookupModelMetadata, getWindow, z.tuple([z.string().min(1).max(200)]), ([id]) =>
		host.lookupModelMetadata(id),
	);
	handle(IPC.modelsList, getWindow, z.tuple([]), () => host.models());
	handle(IPC.configSummary, getWindow, z.tuple([]), () => host.configSummary());

	handle(
		IPC.sessionSelectModel,
		getWindow,
		z.tuple([z.string().min(1).max(200), z.string().min(1).max(500)]),
		([provider, model]) => host.selectModel(provider, model),
	);
	handle(IPC.sessionSelectEffort, getWindow, z.tuple([ReasoningEffortSchema]), ([effort]) => host.selectEffort(effort));
	handle(IPC.sessionSelectApproval, getWindow, z.tuple([ApprovalModeSchema]), ([mode]) => host.selectApproval(mode));
	handle(IPC.sessionSetPlan, getWindow, z.tuple([z.boolean()]), ([enabled]) => host.setPlan(enabled));
	handle(IPC.skillsList, getWindow, z.tuple([]), () => host.skills());
	handle(IPC.trustAccept, getWindow, z.tuple([z.boolean()]), ([remember]) => host.trustAccept(remember));
	handle(IPC.trustDeny, getWindow, z.tuple([]), () => host.trustDeny());
	handle(IPC.mcpStatus, getWindow, z.tuple([]), () => host.mcpStatus());
	handle(IPC.mcpReconnect, getWindow, z.tuple([z.string().min(1).max(200)]), ([name]) => host.mcpReconnect(name));
	handle(IPC.mcpHealth, getWindow, z.tuple([]), () => host.mcpHealth());

	handle(IPC.imagesPick, getWindow, z.tuple([]), () => host.prepareImageFromDialog());
	handle(
		IPC.imagesFromBytes,
		getWindow,
		z.tuple([z.instanceof(Uint8Array), z.string().max(100).optional()]),
		([bytes, mediaType]) => host.prepareImageFromBytes(bytes, mediaType),
	);
	handle(IPC.imagesFromUrl, getWindow, z.tuple([z.string().url().max(4096)]), ([url]) => host.prepareImageFromUrl(url));
}

function handle<A extends readonly unknown[], T>(
	channel: string,
	getWindow: () => BrowserWindow | undefined,
	schema: z.ZodType<A>,
	fn: (args: A) => Promise<T> | T,
): void {
	ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<RpcResult<T>> => {
		if (!isTrustedSender(event, getWindow)) {
			return fail("Request came from an untrusted frame", "unauthorized");
		}
		let parsed: A;
		try {
			parsed = schema.parse(args);
		} catch (error) {
			return fail(messageOf(error), "invalid-request");
		}
		try {
			return { ok: true, value: await fn(parsed) };
		} catch (error) {
			return { ok: false, error: toRpcError(error) };
		}
	});
}

function isTrustedSender(event: IpcMainInvokeEvent, getWindow: () => BrowserWindow | undefined): boolean {
	const window = getWindow();
	if (window === undefined || window.isDestroyed()) return false;
	if (event.sender.id !== window.webContents.id) return false;
	return event.senderFrame === window.webContents.mainFrame;
}

function windowState(window: BrowserWindow | undefined): WindowState {
	if (window === undefined || window.isDestroyed()) return { maximized: false, fullScreen: false };
	return { maximized: window.isMaximized(), fullScreen: window.isFullScreen() };
}

function fail(message: string, code?: string): RpcResult<never> {
	return { ok: false, error: code === undefined ? { message } : { message, code } };
}

function toRpcError(error: unknown): RpcError {
	if (error instanceof DesktopWorkspaceError) return { message: error.message, code: error.code };
	if (error instanceof DesktopGitError) return { message: error.message, code: error.code };
	if (error instanceof SessionBusyError) return { message: error.message, code: "session-busy" };
	if (error instanceof z.ZodError) return { message: error.message, code: "invalid-request" };
	if (error instanceof Error && (error.name === "AbortError" || /aborted/i.test(error.message))) {
		return { message: error.message, code: "aborted" };
	}
	const message = messageOf(error);
	if (message.includes("Workspace trust is required")) return { message, code: "trust-required" };
	if (message.includes("read-only")) return { message, code: "session-busy" };
	if (message.includes("No project is open")) return { message, code: "no-project" };
	if (message.includes("No session is active")) return { message, code: "no-session" };
	return { message };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function mimeOf(path: string): string {
	const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
	switch (extension) {
		case "png":
			return "image/png";
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "webp":
			return "image/webp";
		case "gif":
			return "image/gif";
		case "svg":
			return "image/svg+xml";
		case "pdf":
			return "application/pdf";
		default:
			return "application/octet-stream";
	}
}
