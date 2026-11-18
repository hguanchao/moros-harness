import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { BrowserWindow, Menu, app, dialog, screen, session } from "electron";

import { DesktopHost } from "#src/desktop/main/core-host.ts";
import { registerIpc } from "#src/desktop/main/ipc.ts";
import { PUSH_CHANNEL } from "#src/desktop/shared/contract.ts";

const TITLEBAR_HEIGHT = 44;
const DARK_SURFACE = "#202020";
const LIGHT_SURFACE = "#ebebeb";

let mainWindow: BrowserWindow | undefined;
let host: DesktopHost | undefined;
let quitting = false;
let saveTimer: NodeJS.Timeout | undefined;

// 测试与便携场景：把用户数据与 Moros 主目录指到临时目录，不碰真实配置。
if (process.env.MOROS_DESKTOP_USER_DATA !== undefined && process.env.MOROS_DESKTOP_USER_DATA.length > 0) {
	app.setPath("userData", process.env.MOROS_DESKTOP_USER_DATA);
}

// 单实例：第二次启动只唤起已有窗口；桌面端的会话租约与 MCP 子进程都按进程持有。
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (mainWindow === undefined) return;
		if (mainWindow.isMinimized()) mainWindow.restore();
		mainWindow.show();
		mainWindow.focus();
	});
	void app.whenReady().then(bootstrap, (error: unknown) => {
		dialog.showErrorBox("Moros Harness failed to start", messageOf(error));
		app.quit();
	});
}

async function bootstrap(): Promise<void> {
	app.setName("Moros Harness");
	if (process.platform === "win32") app.setAppUserModelId("com.moros.harness");
	enrichMacPath();
	installCsp();
	installPermissions();
	installMenu();

	host = await DesktopHost.create({
		userDataDir: app.getPath("userData"),
		getWindow: () => mainWindow,
		...(process.env.MOROS_HOME === undefined ? {} : { homeDir: process.env.MOROS_HOME }),
		push: (message) => {
			const window = mainWindow;
			if (window === undefined || window.isDestroyed()) return;
			window.webContents.send(PUSH_CHANNEL, message);
		},
	});
	registerIpc(host, () => mainWindow);

	const initialProject = process.env.MOROS_DESKTOP_PROJECT;
	if (initialProject !== undefined && initialProject.length > 0) {
		await host.openProject(initialProject).catch((error: unknown) => {
			process.stderr.write(`Could not open initial project: ${messageOf(error)}\n`);
		});
	}
	mainWindow = createWindow(host.windowBounds(), host.windowMaximized());
	await loadRenderer(mainWindow);
}

function createWindow(
	bounds: { x: number; y: number; width: number; height: number } | undefined,
	maximized: boolean,
): BrowserWindow {
	const safeBounds = visibleBounds(bounds);
	const window = new BrowserWindow({
		...(safeBounds ?? { width: 1440, height: 900 }),
		minWidth: 980,
		minHeight: 640,
		show: false,
		title: "Moros Harness",
		backgroundColor: DARK_SURFACE,
		titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
		...(process.platform === "darwin"
			? { trafficLightPosition: { x: 16, y: 16 } }
			: {
					titleBarOverlay: {
						color: DARK_SURFACE,
						symbolColor: "#e6e6e6",
						height: TITLEBAR_HEIGHT,
					},
				}),
		webPreferences: {
			preload: join(__dirname, "../preload/index.cjs"),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			webviewTag: false,
			spellcheck: true,
		},
	});
	if (maximized) window.maximize();
	window.once("ready-to-show", () => window.show());
	window.on("close", () => saveWindowState());
	window.on("resize", scheduleSaveWindowState);
	window.on("move", scheduleSaveWindowState);
	window.on("maximize", () => pushWindowState());
	window.on("unmaximize", () => pushWindowState());
	window.on("enter-full-screen", () => pushWindowState());
	window.on("leave-full-screen", () => pushWindowState());
	window.on("closed", () => {
		mainWindow = undefined;
	});

	const contents = window.webContents;
	contents.setWindowOpenHandler(() => ({ action: "deny" }));
	contents.on("will-navigate", (event, url) => {
		const current = contents.getURL();
		if (url !== current) event.preventDefault();
	});
	contents.on("will-attach-webview", (event) => event.preventDefault());
	contents.on("render-process-gone", (_event, details) => {
		dialog.showErrorBox("Moros Harness renderer stopped", `Reason: ${details.reason}`);
	});
	return window;
}

async function loadRenderer(window: BrowserWindow): Promise<void> {
	const devUrl = process.env.ELECTRON_RENDERER_URL;
	if (devUrl !== undefined && devUrl.length > 0) {
		await window.loadURL(devUrl);
	} else {
		await window.loadFile(join(__dirname, "../renderer/index.html"));
	}
}

function installCsp(): void {
	const dev = Boolean(process.env.ELECTRON_RENDERER_URL);
	const policy = dev
		? [
				"default-src 'self'",
				"script-src 'self' 'unsafe-inline' 'unsafe-eval'",
				"style-src 'self' 'unsafe-inline'",
				"img-src 'self' data: blob:",
				"font-src 'self' data:",
				"connect-src 'self' ws: wss: http: https:",
			].join("; ")
		: [
				"default-src 'self'",
				"script-src 'self'",
				"style-src 'self' 'unsafe-inline'",
				"img-src 'self' data: blob:",
				"font-src 'self' data:",
				"connect-src 'self'",
				"object-src 'none'",
				"base-uri 'none'",
			].join("; ");
	session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
		callback({
			responseHeaders: {
				...details.responseHeaders,
				"Content-Security-Policy": [policy],
			},
		});
	});
}

function installPermissions(): void {
	const allowed = new Set(["clipboard-read", "clipboard-sanitized-write"]);
	session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
		callback(allowed.has(permission));
	});
	session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowed.has(permission));
}

function installMenu(): void {
	if (process.platform !== "darwin") {
		Menu.setApplicationMenu(null);
		return;
	}
	Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]));
}

/** Finder 启动的 Electron 不继承终端 PATH；从登录 shell 取一次，供 bash/git/node 探测使用。 */
function enrichMacPath(): void {
	if (process.platform !== "darwin") return;
	try {
		const shell = process.env.SHELL ?? "/bin/zsh";
		const output = execFileSync(shell, ["-ilc", 'printf %s "$PATH"'], {
			encoding: "utf8",
			timeout: 5_000,
		}).trim();
		const line = output
			.split(/\r?\n/)
			.filter((entry) => entry.length > 0)
			.at(-1);
		if (line !== undefined) process.env.PATH = line;
	} catch {
		// 登录 shell 不可用时保留 Electron 继承到的 PATH；doctor 会把缺失工具报出来。
	}
}

function visibleBounds(
	bounds: { x: number; y: number; width: number; height: number } | undefined,
): { x: number; y: number; width: number; height: number } | undefined {
	if (bounds === undefined) return undefined;
	const visible = screen.getAllDisplays().some((display) => {
		const area = display.workArea;
		return (
			bounds.x < area.x + area.width &&
			bounds.x + bounds.width > area.x &&
			bounds.y < area.y + area.height &&
			bounds.y + bounds.height > area.y
		);
	});
	return visible ? bounds : undefined;
}

function scheduleSaveWindowState(): void {
	if (saveTimer !== undefined) clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		saveTimer = undefined;
		saveWindowState();
	}, 500);
}

function saveWindowState(): void {
	if (host === undefined || mainWindow === undefined || mainWindow.isDestroyed()) return;
	const bounds =
		mainWindow.isMaximized() || mainWindow.isFullScreen() ? mainWindow.getNormalBounds() : mainWindow.getBounds();
	void host.rememberWindow(bounds, mainWindow.isMaximized()).catch(() => undefined);
}

function pushWindowState(): void {
	const window = mainWindow;
	if (window === undefined || window.isDestroyed()) return;
	window.webContents.send(PUSH_CHANNEL, {
		type: "window-state",
		state: { maximized: window.isMaximized(), fullScreen: window.isFullScreen() },
	});
}

app.on("window-all-closed", () => {
	app.quit();
});

app.on("before-quit", (event) => {
	if (quitting) return;
	quitting = true;
	event.preventDefault();
	saveWindowState();
	void (async () => {
		await host?.dispose().catch(() => undefined);
		app.quit();
	})();
});

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
