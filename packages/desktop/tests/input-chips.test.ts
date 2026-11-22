import { describe, expect, it } from "vitest";

import { tokenizeForDisplay } from "../src/utils/input-chips.ts";

describe("tokenizeForDisplay 输入展示分段", () => {
	it("空文本返回空分段", () => {
		expect(tokenizeForDisplay("")).toEqual([]);
	});

	it("纯文本原样返回", () => {
		expect(tokenizeForDisplay("帮我分析项目")).toEqual([{ text: "帮我分析项目", chip: false }]);
	});

	it("独立 @ 文件识别为 file chip", () => {
		expect(tokenizeForDisplay("查看 @src/a.txt 内容")).toEqual([
			{ text: "查看 ", chip: false },
			{ text: "@src/a.txt", chip: "file" },
			{ text: " 内容", chip: false },
		]);
	});

	it("name@example.com 不误判", () => {
		expect(tokenizeForDisplay("发到 name@example.com 邮箱")).toEqual([
			{ text: "发到 name@example.com 邮箱", chip: false },
		]);
	});

	it("$ 技能识别为 skill chip，${x} 不误判", () => {
		expect(tokenizeForDisplay("用 $deploy-docs 和 ${home}")).toEqual([
			{ text: "用 ", chip: false },
			{ text: "$deploy-docs", chip: "skill" },
			{ text: " 和 ${home}", chip: false },
		]);
	});

	it("行首引用整行识别为 quote chip", () => {
		expect(tokenizeForDisplay("> 引用内容\n后续输入")).toEqual([
			{ text: "> 引用内容", chip: "quote" },
			{ text: "\n后续输入", chip: false },
		]);
	});

	it("多个 chip 与换行混合", () => {
		expect(tokenizeForDisplay("@a.txt 和 $skill")).toEqual([
			{ text: "@a.txt", chip: "file" },
			{ text: " 和 ", chip: false },
			{ text: "$skill", chip: "skill" },
		]);
	});

	it("@ 后无内容不识别为 chip", () => {
		expect(tokenizeForDisplay("邮箱 @ 后面")).toEqual([{ text: "邮箱 @ 后面", chip: false }]);
	});
});
