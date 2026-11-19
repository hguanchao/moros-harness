import { describe, expect, it } from "vitest";

import type { ProjectRef } from "../src/shared/contract.ts";
import { workspaceRootsMatch, workspaceTarget, workspaceTargetsMatch } from "../src/utils/workspace.ts";

describe("renderer workspace targets", () => {
	it("Windows 根目录比较忽略大小写、斜杠形式和末尾分隔符", () => {
		const left = "C:\\Work\\Project\\";
		const right = "c:/work/project/";

		expect(workspaceRootsMatch(left, right, "win32")).toBe(true);
		expect(workspaceRootsMatch(left, "C:/Work/Other", "win32")).toBe(false);
		expect(workspaceTargetsMatch({ kind: "project", root: left }, { kind: "project", root: right }, "win32")).toBe(
			true,
		);
	});

	it("POSIX 根目录和项目 target 比较区分大小写", () => {
		const platforms: readonly NodeJS.Platform[] = ["linux", "darwin"];
		for (const platform of platforms) {
			expect(workspaceRootsMatch("/Work/Project", "/work/project", platform)).toBe(false);
			expect(workspaceRootsMatch("/work/project/", "/work/project", platform)).toBe(true);
			expect(
				workspaceTargetsMatch(
					{ kind: "project", root: "/Work/Project" },
					{ kind: "project", root: "/work/project" },
					platform,
				),
			).toBe(false);
		}
	});

	it("workspaceTarget(null) 始终指向 tasks，不沿用之前的项目", () => {
		const project: ProjectRef = { root: "C:/work/project", name: "Project" };
		const projectTarget = workspaceTarget(project);

		expect(projectTarget).toEqual({ kind: "project", root: project.root });
		const taskTarget = workspaceTarget(null);
		expect(taskTarget).toEqual({ kind: "tasks" });
		expect(workspaceTargetsMatch(taskTarget, projectTarget, "win32")).toBe(false);
		expect(workspaceTargetsMatch(projectTarget, taskTarget, "win32")).toBe(false);
		expect(workspaceTargetsMatch(taskTarget, { kind: "tasks" }, "linux")).toBe(true);
		expect(workspaceTarget(null)).toEqual({ kind: "tasks" });
	});
});
