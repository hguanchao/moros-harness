import { Screen, clearTitle, setTitle } from "#src/tui/term/index.ts";
import { STATUS, UNTITLED_SESSION, mcpConnectingStatus } from "#src/tui/app/copy/index.ts";
import { mergeCommands } from "#src/tui/app/commands.ts";
import type { TuiOptions } from "#src/tui/app/options.ts";
import { createState } from "#src/tui/app/runtime/state.ts";
import { createInputHandler } from "#src/tui/app/input/dispatch.ts";
import { render } from "#src/tui/app/runtime/render.ts";
import { RENDER_COALESCE_MS, SPINNER_FRAMES } from "#src/tui/app/runtime/constants.ts";
import { onCtrlC } from "#src/tui/app/runtime/ctrl-c.ts";
import { EXIT_SIGNALS, cleanup } from "#src/tui/app/runtime/lifecycle.ts";
import { captureTerminal, type TerminalCapture } from "#src/tui/app/runtime/terminal-capture.ts";
import { drainQueue, notify, startRun } from "#src/tui/app/runtime/run.ts";
import {
	compactFooter,
	footerHeight,
	inputTopRow,
	mainAreaHeight,
	menuOpen,
	modalMenuOpen,
	planning,
	terminalRows,
	terminalWidth,
	todoPanelHeight,
} from "#src/tui/app/runtime/geometry.ts";
import { currentTranscript, markTranscriptDirty } from "#src/tui/app/runtime/transcript-state.ts";
import { noticeText } from "#src/tui/app/runtime/notice.ts";
import {
	approvalPanelTop,
	moveApprovalSelection,
	resolveApproval,
	syncApprovalPrompt,
} from "#src/tui/app/runtime/approval.ts";
import { closePlanReviewAndResume, openPlanReview, pageLines } from "#src/tui/app/runtime/pages.ts";
import {
	setStatus,
	clearStatus,
	resetStatusMeta,
	scheduleStatusClear,
	flashStatus,
} from "#src/tui/app/runtime/status.ts";
import { copyText } from "#src/tui/app/runtime/copy.ts";
import { closeThinking, appendLine, syncTurn, syncTurnFull } from "#src/tui/app/runtime/turn.ts";
import { executeUndo } from "#src/tui/app/runtime/checkpoints.ts";
import {
	attachClipboard,
	attachImagePath,
	attachImageUrl,
	clearAttachments,
	imagesOf,
	insertImageMarker,
	pastedImage,
	readAndInsertImage,
} from "#src/tui/app/input/attachments.ts";
import { undoInput } from "#src/tui/app/input/draft.ts";
import { recordUndo } from "#src/tui/app/input/undo.ts";
import { recallHistory, rememberInput } from "#src/tui/app/input/history.ts";
import { healthCheckMcp, moveMcpCursor, reconnectMcp } from "#src/tui/app/runtime/mcp.ts";
import {
	applyConversation,
	approvePlan,
	executeCommand,
	leavePlan,
	revisePlan,
	switchSession,
} from "#src/tui/app/runtime/commands.ts";
import {
	cancelMenu,
	closeFileMenu,
	closeSkillMenu,
	completeMenu,
	confirmMenu,
	forkSelectedSession,
	insertFileReference,
	insertSkillReference,
	moveMenu,
	openEffortMenu,
	openModelMenu,
	openSessionMenu,
	updateCommandMenu,
	updateFileMenu,
	updateSkillMenu,
} from "#src/tui/app/runtime/panels.ts";
import { submit } from "#src/tui/app/runtime/submit.ts";
import { resolveTrust } from "#src/tui/app/runtime/trust.ts";
import { togglingTranscriptAt } from "#src/tui/app/runtime/view.ts";
import { openLatestViewer } from "#src/tui/app/runtime/viewer.ts";
import type { TuiHost } from "#src/tui/app/runtime/types.ts";
import type { ImageAttachment } from "#src/tui/app/image.ts";
import {
	measureTranscriptView,
	scrollTopForRow as scrollTopForRowImpl,
	type TranscriptMetrics,
} from "#src/tui/app/transcript/index.ts";
import type { TranscriptLine } from "#src/tui/app/transcript/index.ts";

/**
 * 全屏界面入口。
 *
 * 只做装配：建状态、把各域模块绑成一份 host 契约、挂终端事件。各域实现分别在 runtime/
 * 与 input/ 下的独立文件里，互相不直接调用，需要协作时经过 host。
 */
export async function runTui(options: TuiOptions): Promise<number> {
	const state = createState(options);
	/** 整帧写入器；进屏、退屏与每帧绘制都走它，转义序列不在装配层拼。 */
	const screen = new Screen(state.stdout);
	/** 初始化时先占位，装配完成后再指向真正实现。 */
	let onData: (chunk: Buffer) => void = () => {};
	let cleanUp: () => void = () => {};
	/** 备用屏期间的 stderr 接管句柄；进入终端态时赋值，任何退出路径都要释放。 */
	let capture: TerminalCapture | undefined;
	/** 合并窗口内只保留一次待执行的重绘；快速滚动时只画最新状态。 */
	let renderTimer: ReturnType<typeof setTimeout> | undefined;
	let lastRenderAt = 0;
	/** 上一次写进终端的窗口标题；值没变就不重复发 OSC 序列。 */
	let lastTerminalTitle: string | undefined;

	const host: TuiHost = {
		options,
		state,
		render: () => requestRender(),
		setInput: (value, cursor = value.length) => {
			// 撤销栈只收正文变化：光标移动与重设同一段内容不产生可撤销的一步
			if (value !== state.input) {
				state.undoStack = recordUndo(
					state.undoStack,
					{ text: state.input, cursor: state.inputCursor, images: [...state.pendingImages] },
					{ text: value, cursor },
				);
			}
			state.input = value;
			state.inputCursor = Math.min(Math.max(0, cursor), value.length);
		},
		undoInput: () => undoInput(host),
		setStatus: (text, tone) => setStatus(state, text, tone),
		clearStatus: () => clearStatus(state),
		resetStatusMeta: () => resetStatusMeta(state),
		scheduleStatusClear: (delayMs) => scheduleStatusClear(state, host.render, delayMs),
		markTranscriptDirty: () => markTranscriptDirty(state),
		pageLines: (kind, width) => pageLines(host, kind, width),
		openViewer: () => openLatestViewer(host),
		terminalWidth: () => terminalWidth(state),
		terminalHeight: () => terminalRows(state),
		mainAreaHeight: () => mainAreaHeight(state, options),
		footerHeight: () => footerHeight(state, options),
		todoPanelHeight: () => todoPanelHeight(state, options),
		approvalPanelTop: () => approvalPanelTop(state, options),
		inputTopRow: (mainHeight) => inputTopRow(state, options, mainHeight),
		commands: () => mergeCommands(state.builtinCommands, options.pluginCommands?.list() ?? []),
		noticeText: () => noticeText(state),
		currentTranscript: (width) => currentTranscript(state, width),
		maxScroll: () => maxScroll(host),
		planning: () => planning(options),
		menuOpen: () => menuOpen(state),
		modalMenuOpen: () => modalMenuOpen(state),
		compactFooter: () => compactFooter(state),
		scrollTopForRow: (row, limit) => scrollTopForRow(host, row, limit),
		startRun: (prompt, images, run) => startRun(host, prompt, images, run),
		launch: (prompt, images = []) => launch(host, prompt, images),
		drainQueue: () => drainQueue(host),
		appendLine: (active, line) => appendLine(host, active, line),
		syncTurn: (active) => syncTurn(host, active),
		syncTurnFull: (active) => syncTurnFull(host, active),
		closeThinking: (active) => closeThinking(host, active),
		appendCommandTurn: (prompt, response) => appendCommandTurn(host, prompt, response),
		openPlanReview: (plan) => openPlanReview(host, plan),
		closePlanReview: () => closePlanReviewAndResume(host),
		clearAttachments: () => clearAttachments(host),
		syncApprovalPrompt: () => syncApprovalPrompt(host),
		resolveApproval: (answer) => resolveApproval(host, answer),
		moveApprovalSelection: (delta) => moveApprovalSelection(host, delta),
		resolveTrust: (answer) => resolveTrust(host, answer),
		notify: (message) => notify(host, message),
		copyText: (text) => copyText(host, text),
		runUndo: () => executeUndo(host),
		toggleTranscriptAt: (row, column, mainHeight, width) => togglingTranscriptAt(host, row, column, mainHeight, width),
		switchSession: (id, action) => switchSession(host, id, action),
		sessionTitle: (title) => sessionTitle(title),
		moveMcpCursor: (delta) => moveMcpCursor(host, delta),
		reconnectMcp: () => reconnectMcp(host),
		healthCheckMcp: () => healthCheckMcp(host),
		applySession: (result) => applyConversation(host, result),
		rememberInput: (value) => rememberInput(state, value),
		recallHistory: (delta) =>
			recallHistory(state, delta, () => {
				host.updateCommandMenu();
				host.updateFileMenu();
				host.render();
			}),
		insertImageMarker: (image, at) => insertImageMarker(host, image, at),
		attachImagePath: (path, at) => attachImagePath(host, path, at),
		attachImageUrl: (url, at) => attachImageUrl(host, url, at),
		attachClipboard: (at) => attachClipboard(host, at),
		readAndInsertImage: (read, status, at) => readAndInsertImage(host, read, status, at),
		pastedImage: (chunk) => pastedImage(host, chunk),
		imagesInInput: () => imagesOf(state),
		approvePlan: () => approvePlan(host),
		revisePlan: () => revisePlan(host),
		leavePlan: () => leavePlan(host),
		executeUndo: () => executeUndo(host),
		closeFileMenu: (dismissed) => closeFileMenu(host, dismissed),
		updateCommandMenu: () => updateCommandMenu(host),
		updateFileMenu: () => updateFileMenu(host),
		insertFileReference: () => insertFileReference(host, (path, at) => attachImagePath(host, path, at)),
		closeSkillMenu: (dismissed) => closeSkillMenu(host, dismissed),
		updateSkillMenu: () => updateSkillMenu(host),
		insertSkillReference: () => insertSkillReference(host),
		openModelMenu: () => openModelMenu(host),
		openEffortMenu: () => openEffortMenu(host),
		openSessionMenu: () => openSessionMenu(host),
		moveMenu: (delta) => moveMenu(host, delta),
		confirmMenu: () => confirmMenu(host),
		completeMenu: () => completeMenu(host),
		cancelMenu: () => cancelMenu(host),
		forkSelectedSession: () => forkSelectedSession(host),
		executeCommand: (command, args) => executeCommand(host, command, args),
		submit: () => submit(host),
		// cleanUp 在装配完成后才指向真正实现；退出发生在运行期，闭包按调用时的值取即可
		exit: () => cleanUp(),
	};

	options.onHostReady?.(host);
	onData = createInputHandler(host, {
		render: host.render,
		onCtrlC: () => onCtrlC(host, { render: host.render, cleanup: cleanUp }),
		// 箭头包一层：cleanUp 在装配完成时才指向真正实现，直接传值会捕获初始的空函数
		cleanup: () => cleanUp(),
	});
	/**
	 * 进程退出前把终端恢复原样。
	 *
	 * 收尾函数只在能走到的路径上执行；渲染抛错、插件同步异常、被别的进程终止都可能跳过
	 * 它，而留下的 raw mode 与备用屏会让使用者的 shell 直接不可用。这里只写还原序列，
	 * 不碰任何状态，重复执行也无害。
	 */
	const restoreTerminal = (): void => {
		try {
			screen.leave();
			clearTitle(state.stdout);
		} catch {
			// 退出阶段写不进去已经无可挽回，再抛一次只会把真正的原因盖掉
		} finally {
			// 回到主屏之后才把缓冲的 stderr 放出来，长文本折行也不会盖住界面帧
			capture?.release();
		}
	};
	cleanUp = () => {
		process.off("exit", restoreTerminal);
		if (renderTimer !== undefined) {
			clearTimeout(renderTimer);
			renderTimer = undefined;
		}
		try {
			cleanup(state, options, { render: host.render, onData, onInterrupt: cleanUp });
		} finally {
			capture?.release();
		}
	};

	/**
	 * 标题数据源变了才写 OSC 0：每帧都发序列会让终端反复重画 tab。
	 *
	 * 回合进行中给标题加当前帧的盲文转圈前缀，让标签在终端里也看得见「还在跑」；空闲
	 * 时回落成纯标题。转圈计时器每帧 requestRender，这里每次重绘都跟着算一遍，帧推进
	 * 与状态行转圈天然同步；回合结束的收尾重绘会自然写回不带转圈的标题。
	 */
	function syncTerminalTitle(): void {
		const next =
			state.activeTurn === undefined
				? options.terminalTitle?.()
				: `${SPINNER_FRAMES[state.spinnerFrame] ?? ""} ${options.terminalTitle?.() ?? ""}`.trim();
		if (next === undefined || next === lastTerminalTitle) return;
		lastTerminalTitle = next;
		setTitle(state.stdout, next);
	}

	/**
	 * 合并高频重绘。
	 *
	 * 输入、滚轮与状态刷新可能在极短时间内连续请求重绘；每次都整帧写出会让终端排队。
	 * 帧间隔不足 16ms 时只登记一次定时重绘，绘制时读取最新状态。
	 */
	function requestRender(): void {
		if (state.finished) return;
		syncTerminalTitle();
		const now = Date.now();
		const remaining = RENDER_COALESCE_MS - (now - lastRenderAt);
		if (remaining <= 0) {
			if (renderTimer !== undefined) {
				clearTimeout(renderTimer);
				renderTimer = undefined;
			}
			lastRenderAt = now;
			render(host);
			return;
		}
		if (renderTimer !== undefined) return;
		renderTimer = setTimeout(() => {
			renderTimer = undefined;
			lastRenderAt = Date.now();
			if (!state.finished) render(host);
		}, remaining);
	}

	const done = new Promise<number>((resolve) => {
		state.finish = () => resolve(0);
	});

	try {
		// 先接管再写进屏序列：Core、Node warning 与第三方库的 stderr 都不会插进帧里
		capture = captureTerminal();
		screen.enter();
		syncTerminalTitle();
		state.stdin.setRawMode?.(true);
		state.stdin.resume();
		state.stdout.on("resize", host.render);
		state.stdin.on("data", onData);
		// 关窗口（SIGHUP）与被 kill（SIGTERM）和 Ctrl+C 一样要把终端还原，否则 raw mode
		// 与备用屏会留在使用者的 shell 上，必须手工 reset 才能恢复
		for (const signal of EXIT_SIGNALS) process.on(signal, cleanUp);
		process.on("exit", restoreTerminal);
		startLoadingStatus(host);
		host.render();
	} catch (error) {
		cleanUp();
		throw error;
	}

	return done;
}

/**
 * 启动期加载状态。
 *
 * MCP server 在后台握手，有 server 还在 connecting 时状态行显示带进度的连接文案并以
 * 100ms 刷新；全部落定后按结果分流——全部连上就把状态行清掉，装载问题（插件失败/警告、
 * MCP 连接失败）交给对话流顶部的警告区：全部 server 连不上按错误起头，其余按警告。
 * 插件装载在进屏前已经完成，它的问题行同样在这里并入警告区。
 */
function startLoadingStatus(host: TuiHost): void {
	const state = host.state;
	let loadTimer: ReturnType<typeof setInterval> | undefined;
	const problems = host.options.startupProblems ?? [];
	const servers = (): readonly { readonly name: string; readonly status: string; readonly detail: string }[] =>
		(host.options.mcpStatus?.() ?? []).filter((row) => row.status !== "disabled");
	const connectingCount = (): number => servers().filter((row) => row.status === "connecting").length;

	const settle = (): void => {
		const rows = servers();
		const failed = rows.filter((row) => row.status === "unreachable");
		const lines = [...problems];
		for (const row of failed) lines.push(`MCP server ${row.name}: ${row.detail}`);
		if (lines.length === 0) return;
		const lead = rows.length > 0 && failed.length === rows.length ? "Error" : "Warning";
		state.startupProblems = `${lead}: ${lines.join("\n")}`;
	};

	if (connectingCount() === 0) {
		settle();
		return;
	}

	const total = servers().length;
	const tick = (): void => {
		if (state.finished) {
			if (loadTimer !== undefined) clearInterval(loadTimer);
			loadTimer = undefined;
			return;
		}
		if (connectingCount() === 0) {
			if (loadTimer !== undefined) clearInterval(loadTimer);
			loadTimer = undefined;
			settle();
			// 握手结束状态行就退场:成功无声,失败由警告区承担
			clearStatus(state);
			host.render();
			return;
		}
		setStatus(state, mcpConnectingStatus(total - connectingCount(), total));
		host.render();
	};
	tick();
	loadTimer = setInterval(tick, 100);
	// unref：使用者退出时不能被一个还没到点的刷新拖住进程
	loadTimer.unref?.();
}

function maxScroll(host: TuiHost): number {
	const width = host.terminalWidth();
	const mainHeight = host.mainAreaHeight();
	const metrics = measure(host, width, mainHeight);
	return Math.max(0, metrics.scrollLines - mainHeight);
}

function measure(host: TuiHost, width: number, mainHeight: number): TranscriptMetrics {
	return measureTranscriptView(host.currentTranscript(width), mainHeight);
}

/** 滚动条拖动到的行换算成滚动量。 */
function scrollTopForRow(host: TuiHost, row: number, limit: number): number {
	return scrollTopForRowImpl(row, host.mainAreaHeight(), limit);
}

/** 普通提问交给真实对话；没有 agent 时只更新状态行。 */
function launch(host: TuiHost, prompt: string, images: readonly ImageAttachment[]): void {
	const agent = host.options.agent;
	if (agent === undefined) {
		host.state.commandMenu = undefined;
		flashStatus(host, STATUS.agentNotConnected, "notice");
		host.render();
		return;
	}
	startRun(host, prompt, images, (onEvent, signal) => agent.runTurn(prompt, images, onEvent, signal));
}

/**
 * 把一条命令的回复放进对话流。
 *
 * 一轮进行中时先排队，等这一轮结束再追加：对话流会跟着最后一条提示贴底，插在流中间
 * 无论排前还是排后都会被顶走。页脚已经即时反映了新模型，这里是留给回看的记录。
 */
function appendCommandTurn(host: TuiHost, prompt: string, response: readonly TranscriptLine[]): void {
	const state = host.state;
	const block = { prompt, response: [...response] };
	markTranscriptDirty(state);
	state.hasInput = true;
	if (state.activeTurn !== undefined) {
		state.pendingCommandTurns.push(block);
		return;
	}
	state.turns.push(block);
	host.render();
}

/** 会话菜单里的一行标题：控制字符会弄乱面板，统一换成空格。 */
function sessionTitle(title: string | undefined): string {
	const text = (title ?? "").replaceAll(/[\u0000-\u001f\u007f]/g, " ").trim();
	return text.length === 0 ? UNTITLED_SESSION : text;
}
