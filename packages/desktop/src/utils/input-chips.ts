/**
 * 把草稿文本按"富元素显示文字"切成普通段与胶囊段，供输入框镜像层渲染。
 *
 * textarea 仍是唯一输入源（文字透明），本模块只决定哪些文字在镜像里画成灰色胶囊。
 * chip 的 display 若在正文里被用户删掉，就不再匹配 → 胶囊自动消失（以文字为准）。
 */

export interface ChipRef {
	readonly id: string;
	readonly kind: "quote" | "file" | "skill";
	readonly display: string;
}

export interface InputSegment {
	readonly text: string;
	readonly chip?: ChipRef;
}

/** 按 display 在正文中的位置切段（不重叠，左到右）。 */
export function segmentInput(text: string, chips: readonly ChipRef[]): readonly InputSegment[] {
	const matches: { start: number; end: number; chip: ChipRef }[] = [];
	for (const chip of chips) {
		if (chip.display.length === 0) continue;
		const start = text.indexOf(chip.display);
		if (start < 0) continue;
		matches.push({ start, end: start + chip.display.length, chip });
	}
	matches.sort((a, b) => a.start - b.start);

	const segments: InputSegment[] = [];
	let pos = 0;
	for (const match of matches) {
		if (match.start < pos) continue; // 与前一个胶囊重叠，跳过
		if (match.start > pos) segments.push({ text: text.slice(pos, match.start) });
		segments.push({ text: text.slice(match.start, match.end), chip: match.chip });
		pos = match.end;
	}
	if (pos < text.length) segments.push({ text: text.slice(pos) });
	return segments;
}
