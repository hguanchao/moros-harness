/**
 * 输入框展示分段：把纯文本切成普通文本与 chip（@文件 / $技能 / 引用）段落，
 * 供 Composer 的 overlay 镜像渲染灰色胶囊视觉。
 *
 * 仅做视觉分段，不改变 textarea 的输入内容；chip 在文本层仍是普通字符串，
 * 保证光标位置、补全 token、send 协议全部不受影响。
 */

export type ChipKind = "file" | "skill" | "quote";

export interface TextSegment {
	readonly text: string;
	readonly chip: false;
}

export interface ChipSegment {
	readonly text: string;
	readonly chip: ChipKind;
}

export type InputSegment = TextSegment | ChipSegment;

/** 独立 token 判定：@ / $ 必须位于行首或空白之后。 */
function isTokenStart(text: string, index: number): boolean {
	return index === 0 || /\s/.test(text[index - 1] ?? "");
}

/**
 * 把文本切成展示段落。
 *
 * - `@xxx`（xxx 到空白为止）→ file chip
 * - `$xxx`（xxx 为 [A-Za-z0-9_-]）→ skill chip
 * - 行首 `> ` 开头的整行 → quote chip
 * - `name@example.com`、`${x}` 等普通文本不识别为 chip
 */
export function tokenizeForDisplay(text: string): readonly InputSegment[] {
	const segments: InputSegment[] = [];
	let plain = "";
	const flushPlain = (): void => {
		if (plain.length > 0) {
			segments.push({ text: plain, chip: false });
			plain = "";
		}
	};

	const lines = text.split("\n");
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const line = lines[lineIndex] ?? "";
		// 行首 > 引用整行作为 quote chip（含前导 "> "）。
		if (line.startsWith("> ") || line === ">") {
			flushPlain();
			segments.push({ text: line, chip: "quote" });
			if (lineIndex < lines.length - 1) plain += "\n";
			continue;
		}

		let i = 0;
		while (i < line.length) {
			const char = line[i] ?? "";
			const tokenStart = isTokenStart(line, i);
			let chip: ChipKind | undefined;
			let end = i + 1;

			if (char === "@" && tokenStart) {
				while (end < line.length && !/\s/.test(line[end] ?? "")) end += 1;
				if (end > i + 1) chip = "file"; // @ 后必须有内容
			} else if (char === "$" && tokenStart) {
				while (end < line.length && /[A-Za-z0-9_-]/.test(line[end] ?? "")) end += 1;
				if (end > i + 1) chip = "skill";
			}

			if (chip !== undefined) {
				flushPlain();
				segments.push({ text: line.slice(i, end), chip });
				i = end;
			} else {
				plain += char;
				i += 1;
			}
		}
		if (lineIndex < lines.length - 1) plain += "\n";
	}
	flushPlain();
	return segments;
}
