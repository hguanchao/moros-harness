import { PASTE_END, PASTE_START } from "#src/tui/term/index.ts";
import {
	attachmentSetError,
	imageLimitError,
	imageMarker,
	imagesInPrompt,
	isImageUrl,
	uniqueImageName,
	type ImageAttachment,
	type PastedImage,
} from "#src/tui/app/image.ts";
import { editInput } from "#src/tui/app/input/keys.ts";
import {
	IMAGE_STILL_READING,
	IMAGE_URL_UNSUPPORTED,
	STATUS,
	attachedWithoutVision,
	imageError,
} from "#src/tui/app/copy/index.ts";
import { pasteInsertion } from "#src/tui/app/paste.ts";
import { errorLine } from "#src/tui/app/render/status.ts";
import { closeFileMenu } from "#src/tui/app/runtime/panels.ts";
import type { TuiHost } from "#src/tui/app/runtime/types.ts";

/**
 * 输入框里的图片。
 *
 * 图片以正文标记的形式参与编辑：标记是文本，可以随意移动、删除；真正的图片数据另存
 * 在待发送清单里，发送时按还留在正文中的标记取用。
 */

/** 清空待发送图片；递增代次让晚到的读取结果不再落进新输入。 */
export function clearAttachments(host: TuiHost): void {
	host.state.pendingImages = [];
	host.state.attachmentEpoch += 1;
}

/** 把一张图插成正文标记；名称重复时加序号，发送时靠标记找回数据。 */
export function insertImageMarker(host: TuiHost, image: ImageAttachment, at: number): void {
	const state = host.state;
	// 标记已被删掉的图片不再占名额；顺便把失效数据清掉
	state.pendingImages = state.pendingImages.filter((item) => state.input.includes(item.token));
	const used = new Set(state.pendingImages.map((item) => item.image.name));
	const name = uniqueImageName(image.name, used);
	const stored: ImageAttachment = { ...image, name };
	const error = imageLimitError(
		state.pendingImages.map((item) => item.image),
		stored,
	);
	if (error !== undefined) {
		host.setStatus(error, "warning");
		host.scheduleStatusClear();
		host.render();
		return;
	}

	const position = Math.min(Math.max(0, at), state.input.length);
	const before = state.input.slice(0, position);
	const after = state.input.slice(position);
	const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
	// 末尾也补一个空格：连续输入文字或再插一张图时不会和标记粘在一起
	const trail = after.length === 0 || !/^\s/.test(after) ? " " : "";
	const token = imageMarker(name);
	const insertion = `${lead}${token}${trail}`;
	host.setInput(`${before}${insertion}${after}`, position + insertion.length);
	state.pendingImages.push({ token, image: stored });
	closeFileMenu(host);

	if (host.options.imagesSupported?.() === false) {
		host.setStatus(attachedWithoutVision(name), "warning");
		host.scheduleStatusClear();
	}
	host.render();
}

/**
 * 读图后再把标记插进输入框。
 *
 * 位置在开始读取时确定；读完之前禁止发送，避免出现「标记在、图片没跟上」的半轮消息。
 */
export function readAndInsertImage(
	host: TuiHost,
	read: () => Promise<ImageAttachment>,
	status: string,
	at: number,
): void {
	const state = host.state;
	if (state.imageLoading) {
		host.setStatus(IMAGE_STILL_READING, "notice");
		host.scheduleStatusClear();
		host.render();
		return;
	}
	const epoch = state.attachmentEpoch;
	const position = Math.min(Math.max(0, at), state.input.length);
	state.imageLoading = true;
	host.setStatus(status);
	host.render();
	void read()
		.then((image) => {
			// 退出后不要再动界面：备用屏已经离开，此刻写入会画在 shell 上
			if (state.finished) return;
			if (epoch === state.attachmentEpoch) {
				// 读取结束就该收尾：成功路径不写状态，把「读取中」清掉，否则它会一直占着
				// 状态行。状态已被别的阶段占用（回合进行中）时不动它。
				if (state.statusText === status) host.clearStatus();
				insertImageMarker(host, image, position);
			}
		})
		.catch((error: unknown) => {
			if (state.finished || epoch !== state.attachmentEpoch) return;
			host.setStatus(imageError(errorLine(error)), "error");
			host.scheduleStatusClear();
		})
		.finally(() => {
			state.imageLoading = false;
			if (state.finished) return;
			host.render();
		});
}

export function attachImagePath(host: TuiHost, path: string, at = host.state.inputCursor): void {
	const source = host.options.images;
	if (source === undefined) return;
	readAndInsertImage(host, () => source.read(path), STATUS.readingImage, at);
}

/** 下载网络图片再插成标记；失败原因由 Core 抛出的英文错误经状态行呈现。 */
export function attachImageUrl(host: TuiHost, url: string, at = host.state.inputCursor): void {
	const readUrl = host.options.images?.readUrl;
	if (readUrl === undefined) {
		host.setStatus(IMAGE_URL_UNSUPPORTED, "notice");
		host.scheduleStatusClear();
		host.render();
		return;
	}
	readAndInsertImage(host, () => readUrl(url), STATUS.downloadingImage, at);
}

/**
 * Ctrl+V：读剪贴板，图文分流。
 *
 * 先读文本：剪贴板里是文字时（绝大多数时刻）不必再走一遍读图命令。文本走与手动粘贴
 * 同一套规则——短文直插，长文折叠成标记。读到空串或读不了再试图片，两者都没有才报错；
 * 位置在开始读取时确定，与读图的落点规则一致。
 */
export function attachClipboard(host: TuiHost, at = host.state.inputCursor): void {
	const source = host.options.images;
	if (source === undefined) {
		host.setStatus(STATUS.imagesUnsupported, "notice");
		host.scheduleStatusClear();
		host.render();
		return;
	}
	const state = host.state;
	const epoch = state.attachmentEpoch;
	const position = Math.min(Math.max(0, at), state.input.length);
	host.setStatus(STATUS.readingClipboard);
	host.render();
	void source
		.clipboardText()
		.then((text) => {
			if (state.finished || epoch !== state.attachmentEpoch) return;
			// 剪贴板里是一个图片链接时按「贴图」处理，而不是把 URL 当正文插进来
			if (source.readUrl !== undefined && isImageUrl(text)) {
				attachImageUrl(host, text.trim(), position);
				return;
			}
			if (text.length > 0) insertClipboardText(host, text, position);
			else readAndInsertImage(host, () => source.clipboard(), STATUS.readingClipboardImage, position);
		})
		.catch(() => {
			// 文本通道缺席（比如 Linux 没装 wl-paste/xclip）不拦着读图
			if (state.finished || epoch !== state.attachmentEpoch) return;
			readAndInsertImage(host, () => source.clipboard(), STATUS.readingClipboardImage, position);
		});
}

/** 把剪贴板文本当作一次 bracketed paste 写进输入框：清理与折叠都走 editInput 的同一条路径。 */
function insertClipboardText(host: TuiHost, text: string, at: number): void {
	const state = host.state;
	const edit = editInput(state.input, at, `${PASTE_START}${text}${PASTE_END}`, false, (pasteText, before) =>
		pasteInsertion(state.pastes, pasteText, before),
	);
	if (edit.text !== state.input) {
		host.setInput(edit.text, edit.cursor);
		state.historyIndex = -1;
		host.updateCommandMenu();
		host.updateFileMenu();
		host.updateSkillMenu();
	}
	// 「读取中」的提示在这里收尾；状态已被回合阶段占用时不动它
	if (state.statusText === STATUS.readingClipboard) host.clearStatus();
	host.render();
}

/**
 * 整段粘贴内容如果就是一个图片来源，返回它的种类与地址。
 *
 * 本地文件走 `detect`（存在才算），网络图片要求形状像图片 URL（见 `isImageUrl`）；
 * 夹着说明文字或换行的粘贴仍然按普通文本处理。URL 只有在用户显式粘贴时才抓取。
 */
export function pastedImage(host: TuiHost, chunk: string): PastedImage | undefined {
	const source = host.options.images;
	if (source === undefined) return undefined;
	const candidate = pastedCandidate(chunk);
	if (candidate === undefined) return undefined;
	// 先判 URL：形状判断不碰文件系统，本地路径不可能以 http(s) 开头，不会互相误判
	if (source.readUrl !== undefined && isImageUrl(candidate)) return { kind: "url", value: candidate };
	const path = source.detect(candidate);
	if (path !== undefined) return { kind: "file", value: path };
	return undefined;
}

/** 取出整段粘贴的候选文本；折叠标记里的内容也要拆出来。 */
function pastedCandidate(chunk: string): string | undefined {
	const trimmed = chunk.trim();
	let candidate = trimmed;
	if (trimmed.startsWith(PASTE_START)) {
		if (!trimmed.endsWith(PASTE_END)) return undefined;
		candidate = trimmed.slice(PASTE_START.length, -PASTE_END.length);
	}
	if (candidate.length === 0 || candidate.length > 4096) return undefined;
	if (/[\r\n\x1b]/.test(candidate)) return undefined;
	return candidate;
}

/** 提交时按还留在正文里的标记取出图片；标记被删掉的图片不再发送。 */
export function imagesOf(state: {
	readonly input: string;
	readonly pendingImages: import("#src/tui/app/image.ts").PendingImage[];
}): readonly ImageAttachment[] {
	return imagesInPrompt(state.input, state.pendingImages);
}

/** 附件集合的容量校验；超限时返回可直接写进状态行的原因。 */
export function attachmentLimit(images: readonly ImageAttachment[]): string | undefined {
	return attachmentSetError(images);
}
