import { describe, expect, it } from "vitest";

import {
	countTools,
	describeToolGroup,
	isEditTool,
	isExploreTool,
	toolVerb,
} from "../src/utils/tool-labels.ts";

describe("工具文案映射", () => {
	it("单工具中文动词", () => {
		expect(toolVerb("read")).toBe("读取");
		expect(toolVerb("write")).toBe("写入");
		expect(toolVerb("edit")).toBe("编辑");
		expect(toolVerb("bash")).toBe("运行命令");
		expect(toolVerb("web_fetch")).toBe("获取网页");
	});

	it("未知工具原样显示", () => {
		expect(toolVerb("custom_tool")).toBe("custom_tool");
	});

	it("探索/编辑类工具判定", () => {
		expect(isExploreTool("read")).toBe(true);
		expect(isExploreTool("glob")).toBe(true);
		expect(isExploreTool("bash")).toBe(false);
		expect(isEditTool("write")).toBe(true);
		expect(isEditTool("edit")).toBe(true);
		expect(isEditTool("read")).toBe(false);
	});

	it("按动词聚合并保持首次出现顺序", () => {
		expect(countTools(["read", "read", "grep", "bash"])).toEqual([
			{ verb: "读取", count: 2 },
			{ verb: "搜索内容", count: 1 },
			{ verb: "运行命令", count: 1 },
		]);
	});

	it("全探索类：读取+查找文件 -> 探索了 N 处", () => {
		expect(describeToolGroup(["read", "glob", "grep"], false)).toBe("探索了 3 处");
		expect(describeToolGroup(["read", "glob"], true)).toBe("正在探索 2 处");
	});

	it("全编辑类：写入+编辑 -> 编辑了 N 处", () => {
		expect(describeToolGroup(["write", "edit"], false)).toBe("编辑了 2 处");
	});

	it("混合：动词+计数用顿号连接", () => {
		expect(describeToolGroup(["read", "bash", "bash"], false)).toBe("读取 1、运行命令 2");
		expect(describeToolGroup(["read", "bash"], true)).toBe("正在 读取 1、运行命令 1");
	});

	it("空列表兜底", () => {
		expect(describeToolGroup([], false)).toBe("已准备工作");
		expect(describeToolGroup([], true)).toBe("正在准备工作");
	});
});
