import { describe, expect, it } from "vitest";

import {
	filterCommands,
	filterFiles,
	filterSkills,
	findAtToken,
	findSkillToken,
	findSlashToken,
	findTriggerToken,
	formatFileReference,
	formatSkillReference,
	removeTriggerText,
	type CommandCandidate,
	type SkillCandidate,
} from "../src/utils/inline-completion.ts";
import { DESKTOP_COMMANDS, findDesktopCommand } from "../src/utils/command-list.ts";
import { runDesktopCommand, splitCommand } from "../src/utils/command-runner.ts";

describe("findTriggerToken 触发片段定位", () => {
	it("行首 / 空白后的 @ 才触发", () => {
		expect(findAtToken("@src/main.ts", 12)).toMatchObject({ start: 0, query: "src/main.ts" });
		expect(findAtToken("查看 @src/app 文件", 11)).toMatchObject({ query: "src/app" });
	});

	it("邮箱等普通文本不触发", () => {
		expect(findAtToken("name@example.com", 16)).toBeUndefined();
		expect(findSkillToken("花了$5", 4)).toBeUndefined();
		expect(findSkillToken("${home}/x", 3)).toBeUndefined();
	});

	it("回归：光标紧跟插入的尾随空格时会产生含空格的幽灵 token（由 Composer 守卫拦截）", () => {
		// 这是补全误弹的根因场景，Composer 通过「光标前一字符为空白则关闭补全」规避。
		expect(findAtToken("@a.txt ", 7)).toMatchObject({ start: 0, end: 7, query: "a.txt " });
	});

	it("$ 片段只吃安全字符", () => {
		const token = findSkillToken("用 $deploy-docs 技能", 14);
		expect(token).toMatchObject({ query: "deploy-docs" });
		expect(findSkillToken("$a.b", 4)).toBeUndefined();
	});

	it("/ 命令片段只吃字母", () => {
		expect(findSlashToken("/compact", 8)).toMatchObject({ start: 0, query: "compact" });
		expect(findSlashToken("用 /model v4", 8)).toMatchObject({ query: "model" });
	});

	it("光标在片段中间时 query 到光标为止，end 到片段末尾", () => {
		const token = findTriggerToken("@src/app", 4, "@", (char) => !/\s/.test(char));
		expect(token).toMatchObject({ start: 0, end: 8, query: "src" });
	});

	it("trigger 前无空白、行首之外不触发", () => {
		expect(findTriggerToken("abc@def", 7, "@", (char) => !/\s/.test(char))).toBeUndefined();
	});
});

describe("过滤函数排序", () => {
	it("filterFiles：文件名前缀优先，其次路径前缀/包含", () => {
		const files = ["src/utils/a.ts", "a.ts", "docs/readme.md", "src/config.ts"];
		expect(filterFiles(files, "a")).toEqual(["a.ts", "src/utils/a.ts", "docs/readme.md"]);
	});

	it("filterFiles：空 query 返回前 limit 条", () => {
		expect(filterFiles(["a", "b", "c"], "", 2)).toEqual(["a", "b"]);
	});

	it("filterSkills：名称前缀 > 名称包含 > 描述包含", () => {
		const skills: SkillCandidate[] = [
			{ name: "deploy", description: "部署" },
			{ name: "docs", description: "部署文档" },
			{ name: "a-deploy-b", description: "x" },
		];
		expect(filterSkills(skills, "deploy").map((skill) => skill.name)).toEqual(["deploy", "a-deploy-b"]);
	});

	it("filterCommands：前缀命中优先，为空才用描述命中", () => {
		const commands: CommandCandidate[] = [
			{ name: "model", description: "选择模型" },
			{ name: "compact", description: "压缩模型上下文" },
		];
		// query "model" 前缀命中 model，不再混入描述命中的 compact
		expect(filterCommands(commands, "model").map((command) => command.name)).toEqual(["model"]);
		// query "压缩" 走描述命中
		expect(filterCommands(commands, "压缩").map((command) => command.name)).toEqual(["compact"]);
	});

	it("hidden 命令仅完整输入时可见", () => {
		const commands: CommandCandidate[] = [
			{ name: "secret", description: "x", hidden: true },
			{ name: "model", description: "模型" },
		];
		expect(filterCommands(commands, "sec").map((c) => c.name)).toEqual([]);
		expect(filterCommands(commands, "secret").map((c) => c.name)).toEqual(["secret"]);
	});
});

describe("写回与清理", () => {
	it("formatFileReference：含空格路径加引号", () => {
		expect(formatFileReference("src/a.ts")).toBe("@src/a.ts");
		expect(formatFileReference("my docs/readme.md")).toBe('@"my docs/readme.md"');
	});

	it("formatSkillReference", () => {
		expect(formatSkillReference("deploy-docs")).toBe("$deploy-docs");
	});

	it("removeTriggerText 从文本中移除片段", () => {
		const token = findSlashToken("用 /mod 命令", 5);
		expect(token).toBeDefined();
		if (token === undefined) return;
		expect(removeTriggerText("用 /mod 命令", token)).toEqual({ text: "用  命令", cursor: 2 });
	});
});

describe("命令清单与分派", () => {
	it("只保留 compact 与 review 两条命令", () => {
		expect(findDesktopCommand("compact")?.description).toBeTruthy();
		expect(findDesktopCommand("review")?.description).toBeTruthy();
		// 其余操作桌面端都有专门 UI 入口，不再作为命令
		for (const name of ["model", "effort", "approval", "plan", "undo", "export", "session", "skills", "mcps"]) {
			expect(findDesktopCommand(name)).toBeUndefined();
		}
	});

	it("splitCommand 按首个空格拆分", () => {
		expect(splitCommand("/review 检查登录逻辑")).toEqual({ name: "/review", args: "检查登录逻辑" });
		expect(splitCommand("  /compact  ")).toEqual({ name: "/compact", args: "" });
	});

	it("runDesktopCommand 分派到对应 handler", async () => {
		let called = "";
		const handlers = {
			compact: () => {
				called = "compact";
			},
			review: () => undefined,
		};
		expect(await runDesktopCommand("compact", "", handlers)).toBe(true);
		expect(called).toBe("compact");
		expect(await runDesktopCommand("unknown", "", handlers)).toBe(false);
	});
});
