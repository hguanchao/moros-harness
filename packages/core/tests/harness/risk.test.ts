import { describe, expect, it } from "vitest";

import { assessCommandRisk, isAutoApproved } from "@moros/core/harness/risk.ts";

describe("assessCommandRisk", () => {
	it.each([
		["ls -la"],
		["git status"],
		["git diff --stat"],
		["npm test"],
		["npm run build"],
		["pytest -q"],
		["cargo test"],
		["tsc --noEmit"],
		["docker --version"],
		["python scripts/build.py"],
		["bash -x scripts/build.sh"],
		["cd src && npm test"],
		["sed -n '1,5p' package.json"],
		["echo 'a;b'"],
	])("把只读/构建类命令判为 low：%s", (command) => {
		expect(assessCommandRisk(command).level).toBe("low");
	});

	it.each([["git commit -m 'x'"], ["mkdir -p out"], ["cp a b"], ["sed -i 's/a/b/' file"], ["prettier --write src"]])(
		"把工作区内可回滚的写入判为 medium：%s",
		(command) => {
			expect(assessCommandRisk(command).level).toBe("medium");
		},
	);

	it.each([
		["curl https://example.com"],
		["rm -rf build"],
		["bash -c 'npm test'"],
		["bash -lc 'curl https://example.com'"],
		["node -e 'process.exit(0)'"],
		["node -p '1+1'"],
		["python -uc 'print(1)'"],
		["powershell -EncodedCommand ZQBjAGgAbwA="],
		["npx cowsay hi"],
		["npm install left-pad"],
		["pip install requests"],
		["git push origin main"],
		["git reset --hard HEAD~1"],
		["docker ps"],
		["sudo rm -rf /"],
		["frobnicate --now"],
	])("把越界/联网/不可逆/未知命令判为 high：%s", (command) => {
		expect(assessCommandRisk(command).level).toBe("high");
	});

	it("整条链取最高风险段，前半段无害也挡不住后半段", () => {
		expect(assessCommandRisk("cd src && npm test && rm -rf dist").level).toBe("high");
	});

	it("去掉 Windows 路径与脚本后缀后再匹配动词", () => {
		expect(assessCommandRisk(String.raw`C:\Windows\System32\curl.exe https://example.com`)).toMatchObject({
			level: "high",
			rule: "network-egress",
		});
	});

	it("auto 档只拦 high", () => {
		expect(isAutoApproved("low")).toBe(true);
		expect(isAutoApproved("medium")).toBe(true);
		expect(isAutoApproved("high")).toBe(false);
	});
});
