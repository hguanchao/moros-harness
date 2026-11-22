import { describe, expect, it } from "vitest";

import { groupByTarget, targetKey, type BatchEntry } from "../src/utils/batch.ts";
import type { WorkspaceTarget } from "../src/shared/contract.ts";

const tasks: WorkspaceTarget = { kind: "tasks" };
const ferry: WorkspaceTarget = { kind: "project", root: "D:/work/ferry" };
const demo: WorkspaceTarget = { kind: "project", root: "D:/work/demo" };

function entry(id: string, target: WorkspaceTarget): BatchEntry {
	return { id, target };
}

describe("targetKey", () => {
	it("任务根归到固定的 tasks 键", () => {
		expect(targetKey(tasks)).toBe("tasks");
	});

	it("项目根使用 project: 前缀区分", () => {
		expect(targetKey(ferry)).toBe("project:D:/work/ferry");
		expect(targetKey(ferry)).not.toBe(targetKey(demo));
	});
});

describe("groupByTarget 归属分组", () => {
	it("空输入返回空映射", () => {
		expect(groupByTarget([]).size).toBe(0);
	});

	it("任务根与多个项目混合时按目标分成三组", () => {
		const groups = groupByTarget([entry("a", tasks), entry("b", ferry), entry("c", demo), entry("d", tasks)]);
		expect(groups.size).toBe(3);
		expect([...groups.keys()]).toEqual(["tasks", "project:D:/work/ferry", "project:D:/work/demo"]);
		expect(groups.get("tasks")?.ids).toEqual(["a", "d"]);
		expect(groups.get("project:D:/work/ferry")?.ids).toEqual(["b"]);
		expect(groups.get("project:D:/work/demo")?.ids).toEqual(["c"]);
	});

	it("保留每个分组的原始目标对象供 IPC 调用", () => {
		const groups = groupByTarget([entry("b", ferry)]);
		expect(groups.get("project:D:/work/ferry")?.target).toBe(ferry);
	});

	it("同一 id 重复出现时只保留一次", () => {
		const groups = groupByTarget([entry("a", tasks), entry("a", tasks), entry("b", tasks)]);
		expect(groups.get("tasks")?.ids).toEqual(["a", "b"]);
	});
});
