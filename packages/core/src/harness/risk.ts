import { splitCommandSegments, tokenizeCommandSegment } from "./command-text.ts";

/**
 * 命令风险分级：给审批闸门提供「该不该打断使用者」的确定性依据。
 *
 * 这里不用模型，只做规则判定——auto 档的意义是省掉重复确认，不是把判断力外包给
 * 另一个概率模型。分级口径只有一件事：这条命令**最坏能造成什么后果**。
 *
 * - low：只读、构建、测试、版本探测，以及工作区内的仓库脚本；错了也能重跑。
 * - medium：工作区内的可回滚写入（新建、复制、格式化、git 提交）；有快照兜底。
 * - high：越过工作区边界、联网、提权、装包、执行内联代码、破坏性动作，以及**认不出来**的命令。
 *
 * 认不出来的命令归 high 是有意的：没有沙箱时，「已知安全才放行」是唯一诚实的姿势，
 * 使用者可以用审批卡的「本会话放行」按命令前缀把它降级成免打扰。
 */

/** 命令风险分级。 */
export type RiskLevel = "low" | "medium" | "high";

export interface RiskAssessment {
	readonly level: RiskLevel;
	/** 命中规则的稳定标识；写进审批事件，事后能解释「为什么问这一下」。 */
	readonly rule: string;
}

/** 没有命令文本的工具（写文件等）按中风险处理：写入由快照与路径沙箱兜底。 */
export const FILE_TOOL_RISK: RiskAssessment = { level: "medium", rule: "file-write" };

/** auto 档可以静默放行的等级；high 一律转人工审批。 */
export function isAutoApproved(level: RiskLevel): boolean {
	return level !== "high";
}

const SEVERITY: Readonly<Record<RiskLevel, number>> = { low: 1, medium: 2, high: 3 };

interface SegmentContext {
	/** 命令动词：可执行文件名，去掉目录与 .exe/.cmd/.ps1 等后缀，已小写。 */
	readonly head: string;
	/** 第一个参数，已小写；子命令通常落在这里。 */
	readonly sub: string;
	/** 去掉命令动词后的全部参数，已小写。 */
	readonly args: readonly string[];
	/** args 中以 `-` 开头的开关，已小写。 */
	readonly flags: ReadonlySet<string>;
}

interface SegmentRule {
	readonly id: string;
	readonly level: RiskLevel;
	readonly matches: (context: SegmentContext) => boolean;
}

const INTERPRETERS = new Set([
	"bash",
	"sh",
	"zsh",
	"dash",
	"ksh",
	"fish",
	"cmd",
	"powershell",
	"pwsh",
	"node",
	"deno",
	"bun",
	"python",
	"python3",
	"py",
	"perl",
	"ruby",
	"php",
	"lua",
	"rscript",
]);

/** 解释器的「内联代码」开关：命令文本从参数里拼出来，规则看不住真正要跑的东西。 */
const INLINE_FLAGS = new Set(["-c", "-e", "--eval", "-enc", "-encodedcommand", "-command", "/c", "/k", "-exec", "-r"]);

/** 短开关可以合并（`bash -lc`、`python -uc`），只看首尾会漏判，因此按字母判断。 */
const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "cmd"]);
const JS_RUNTIMES = new Set(["node", "deno", "bun"]);

const VERSION_FLAGS = new Set(["--version", "-v", "version", "-version"]);

const PRIVILEGE = new Set(["sudo", "doas", "runas", "su", "pkexec"]);

const NETWORK = new Set([
	"curl",
	"wget",
	"nc",
	"ncat",
	"netcat",
	"ftp",
	"sftp",
	"telnet",
	"ssh",
	"scp",
	"invoke-webrequest",
	"invoke-restmethod",
	"iwr",
	"irm",
	"start-bitstransfer",
	"test-netconnection",
	"test-connection",
]);

const DESTRUCTIVE = new Set([
	"rm",
	"del",
	"erase",
	"rmdir",
	"rd",
	"shred",
	"remove-item",
	"clear-content",
	"clear-item",
	"format-volume",
]);

/** 工作区之外的系统级入口：容器、集群、云、数据库、代码托管。 */
const INFRA = new Set([
	"docker",
	"podman",
	"nerdctl",
	"kubectl",
	"helm",
	"kustomize",
	"terraform",
	"tofu",
	"pulumi",
	"aws",
	"gcloud",
	"az",
	"firebase",
	"vercel",
	"netlify",
	"heroku",
	"railway",
	"fly",
	"flyctl",
	"gh",
	"psql",
	"mysql",
	"mariadb",
	"mongosh",
	"mongo",
	"redis-cli",
	"sqlite3",
	"minikube",
	"kind",
]);

const PACKAGE_SCRIPT_HEADS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_INSTALL_SUBS = new Set([
	"install",
	"i",
	"add",
	"ci",
	"update",
	"upgrade",
	"publish",
	"link",
	"unlink",
	"remove",
	"uninstall",
	"dedupe",
	"prune",
]);
const PACKAGE_SCRIPT_SUBS = new Set(["run", "run-script", "test", "t", "start"]);

/** 下载即执行：包内容不经过任何审查。 */
const DOWNLOAD_RUNNERS = new Set(["npx", "pnpx", "bunx", "dlx", "uvx"]);

const PYTHON_INSTALLERS = new Set(["pip", "pip3", "uv", "poetry", "conda", "mamba"]);
const PYTHON_INSTALL_ARGS = new Set(["install", "add", "sync", "update", "uninstall", "download"]);

const SYSTEM_INSTALLERS = new Set([
	"apt",
	"apt-get",
	"dnf",
	"yum",
	"apk",
	"pacman",
	"zypper",
	"brew",
	"choco",
	"winget",
	"scoop",
	"snap",
]);

const GIT_DESTRUCTIVE = new Set(["clean", "rebase", "filter-branch", "filter-repo", "push", "rm"]);
const GIT_WRITE = new Set([
	"add",
	"commit",
	"merge",
	"tag",
	"switch",
	"checkout",
	"stash",
	"restore",
	"fetch",
	"pull",
	"config",
	"init",
	"worktree",
	"cherry-pick",
	"mv",
	"am",
	"apply",
	"notes",
]);
const GIT_READ = new Set([
	"status",
	"diff",
	"log",
	"show",
	"branch",
	"remote",
	"blame",
	"rev-parse",
	"describe",
	"ls-files",
	"shortlog",
	"grep",
	"help",
	"version",
	"whatchanged",
	"reflog",
]);

const MUTATORS = new Set([
	"mkdir",
	"md",
	"touch",
	"cp",
	"copy",
	"mv",
	"move",
	"ln",
	"mklink",
	"tee",
	"chmod",
	"chown",
	"chgrp",
	"rename",
	"rsync",
	"new-item",
	"copy-item",
	"move-item",
	"rename-item",
	"set-content",
	"add-content",
	"out-file",
	"set-item",
	"set-itemproperty",
	"new-itemproperty",
]);

const NAVIGATION = new Set(["cd", "chdir", "pushd", "popd", "clear", "cls", "exit", "true", "false"]);

const READ_ONLY = new Set([
	"ls",
	"dir",
	"cat",
	"type",
	"head",
	"tail",
	"less",
	"more",
	"pwd",
	"echo",
	"printf",
	"which",
	"where",
	"whoami",
	"date",
	"uname",
	"env",
	"printenv",
	"stat",
	"file",
	"du",
	"df",
	"find",
	"fd",
	"rg",
	"grep",
	"egrep",
	"fgrep",
	"sed",
	"awk",
	"jq",
	"sort",
	"uniq",
	"wc",
	"cut",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"tree",
	"hostname",
	"get-childitem",
	"gci",
	"get-content",
	"gc",
	"get-location",
	"gl",
	"select-string",
	"sls",
	"get-item",
	"gi",
	"get-command",
	"gcm",
	"test-path",
	"resolve-path",
	"write-output",
	"write-host",
	"get-date",
	"get-process",
	"measure-object",
	"compare-object",
]);

const BUILD_HEADS = new Set([
	"make",
	"gmake",
	"pytest",
	"tox",
	"nox",
	"ruff",
	"mypy",
	"pyright",
	"tsc",
	"eslint",
	"prettier",
	"black",
	"isort",
	"gofmt",
	"golangci-lint",
	"mvn",
	"gradle",
]);

const BUILD_SUB_HEADS = new Set(["cargo", "go", "dotnet", "deno"]);
const BUILD_SUBS = new Set(["build", "test", "check", "vet", "clippy", "fmt", "run", "bench", "doc", "pack"]);

/**
 * 规则表按「先特殊、后一般」排列：版本探测最先（`docker --version` 不该被当成集群操作），
 * 然后是各类 high，再 medium，最后 low。第一个命中的规则决定这一段的风险。
 */
const RULES: readonly SegmentRule[] = [
	{
		id: "version-probe",
		level: "low",
		matches: ({ args }) => args.length <= 1 && args[0] !== undefined && VERSION_FLAGS.has(args[0]),
	},
	{
		id: "interpreter-inline",
		level: "high",
		matches: ({ head, args }) => INTERPRETERS.has(head) && isInlineInvocation(head, args),
	},
	{ id: "privilege-escalation", level: "high", matches: ({ head }) => PRIVILEGE.has(head) },
	{ id: "network-egress", level: "high", matches: ({ head }) => NETWORK.has(head) },
	{ id: "destructive-command", level: "high", matches: ({ head }) => DESTRUCTIVE.has(head) },
	{ id: "infra-control", level: "high", matches: ({ head }) => INFRA.has(head) },
	{ id: "download-and-run", level: "high", matches: ({ head }) => DOWNLOAD_RUNNERS.has(head) },
	{
		id: "package-install",
		level: "high",
		matches: ({ head, sub, args }) => {
			if (PACKAGE_SCRIPT_HEADS.has(head)) return PACKAGE_INSTALL_SUBS.has(sub);
			if (PYTHON_INSTALLERS.has(head)) return args.some((arg) => PYTHON_INSTALL_ARGS.has(arg));
			if (SYSTEM_INSTALLERS.has(head)) return true;
			if (head === "cargo" || head === "go") return sub === "install";
			if (head === "gem") return sub === "install" || sub === "update";
			if (head === "composer") return ["require", "install", "update"].includes(sub);
			if (head === "dotnet") return sub === "add";
			return false;
		},
	},
	{
		id: "git-destructive",
		level: "high",
		matches: ({ head, sub, flags }) =>
			head === "git" && (GIT_DESTRUCTIVE.has(sub) || (sub === "reset" && flags.has("--hard"))),
	},
	{
		id: "workspace-mutation",
		level: "medium",
		matches: ({ head, flags }) => {
			if (MUTATORS.has(head)) return true;
			if (head === "sed") return flags.has("-i") || flags.has("--in-place");
			if (head === "prettier" || head === "eslint" || head === "ruff")
				return flags.has("--write") || flags.has("--fix");
			if (head === "black") return !flags.has("--check");
			return false;
		},
	},
	{ id: "git-write", level: "medium", matches: ({ head, sub }) => head === "git" && GIT_WRITE.has(sub) },
	{ id: "git-read", level: "low", matches: ({ head, sub }) => head === "git" && GIT_READ.has(sub) },
	{ id: "git-other", level: "medium", matches: ({ head }) => head === "git" },
	{ id: "navigation", level: "low", matches: ({ head }) => NAVIGATION.has(head) },
	{ id: "read-only", level: "low", matches: ({ head }) => READ_ONLY.has(head) },
	{
		id: "build-test",
		level: "low",
		matches: ({ head, sub }) =>
			BUILD_HEADS.has(head) ||
			(BUILD_SUB_HEADS.has(head) && BUILD_SUBS.has(sub)) ||
			(PACKAGE_SCRIPT_HEADS.has(head) && PACKAGE_SCRIPT_SUBS.has(sub)),
	},
	{ id: "repo-script", level: "low", matches: ({ head }) => INTERPRETERS.has(head) },
];

/**
 * 评估一条命令的风险等级。
 *
 * 命令按 `;`、`&`、`|`、换行切成多段，整条命令取各段中最高的那一级——`cd x && rm -rf y`
 * 里前半段再无害，也挡不住后半段是 high。
 * @param command 模型给出的原始命令文本。
 * @returns 风险等级与命中规则；无法识别时返回 high。
 */
export function assessCommandRisk(command: string): RiskAssessment {
	let worst: RiskAssessment = { level: "low", rule: "no-command" };
	for (const segment of splitCommandSegments(command)) {
		const tokens = tokenizeCommandSegment(segment);
		if (tokens.length === 0) continue;
		const assessment = assessSegment(tokens);
		if (SEVERITY[assessment.level] > SEVERITY[worst.level]) worst = assessment;
	}
	return worst;
}

function assessSegment(tokens: readonly string[]): RiskAssessment {
	const head = commandName(tokens[0] ?? "");
	const args = tokens.slice(1).map((token) => token.toLowerCase());
	const context: SegmentContext = {
		head,
		sub: args[0] ?? "",
		args,
		flags: new Set(args.filter((arg) => arg.startsWith("-"))),
	};
	for (const rule of RULES) {
		if (rule.matches(context)) return { level: rule.level, rule: rule.id };
	}
	return { level: "high", rule: "unknown-command" };
}

/**
 * 判断解释器是否在执行内联代码。
 *
 * 除了 `-c`/`-e` 这类完整写法，还要认 `-lc`、`-uc`、`-pe` 这种合并短开关：漏掉它们，
 * `bash -lc "curl ..."` 就会被当成「跑仓库脚本」放过去。
 */
function isInlineInvocation(head: string, args: readonly string[]): boolean {
	return args.some((arg) => {
		if (INLINE_FLAGS.has(arg)) return true;
		if (arg.startsWith("--")) return arg === "--eval" || arg === "--print";
		if (!arg.startsWith("-") || arg.length < 2) return false;
		const letters = arg.slice(1);
		// 只认纯字母的短开关：`-W=error`、`-Dfoo=bar` 之类带值的开关不在此列
		if (!/^[a-z]+$/i.test(letters)) return false;
		const lower = letters.toLowerCase();
		if (SHELL_INTERPRETERS.has(head) || head === "python" || head === "python3" || head === "py") {
			return lower.includes("c");
		}
		if (JS_RUNTIMES.has(head)) return lower.includes("e") || lower.includes("p");
		return lower.includes("e");
	});
}

/** 取可执行文件名：去掉目录前缀与 Windows 脚本后缀，避免 `C:\Windows\System32\curl.exe` 漏判。 */
function commandName(token: string): string {
	const base = token.split(/[\\/]/).pop() ?? token;
	return base.toLowerCase().replace(/\.(?:exe|cmd|bat|com|ps1|sh)$/, "");
}
