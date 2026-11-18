import DOMPurify from "dompurify";
import { common, createLowlight } from "lowlight";
import { Marked } from "marked";
import { useMemo, type JSX, type MouseEvent } from "react";

const lowlight = createLowlight(common);

const marked = new Marked({
	gfm: true,
	breaks: true,
	renderer: {
		code({ text, lang }) {
			const language = typeof lang === "string" && lang.length > 0 && lowlight.registered(lang) ? lang : undefined;
			let highlighted: string;
			try {
				highlighted = language === undefined ? escapeHtml(text) : hastToHtml(lowlight.highlight(language, text));
			} catch {
				highlighted = escapeHtml(text);
			}
			const className = language === undefined ? "hljs" : `hljs language-${escapeHtml(language)}`;
			return `<pre><code class="${className}">${highlighted}</code></pre>`;
		},
		html({ text }) {
			// 模型输出里的原始 HTML 一律当文本；渲染层只接受 Markdown 生成的标签。
			return escapeHtml(text);
		},
		link({ href, title, text }) {
			const safeHref = isSafeLink(href) ? href : "#";
			const titleAttr = title === null || title === undefined ? "" : ` title="${escapeHtml(title)}"`;
			return `<a href="${escapeHtml(safeHref)}"${titleAttr} target="_blank" rel="noreferrer noopener">${text}</a>`;
		},
		image({ href, title, text }) {
			// 模型输出不自动加载图片：远程图片会泄露访问行为，data: 图片也可能无限膨胀。
			const label = text.length > 0 ? text : "image";
			if (!isSafeLink(href)) return `<span>${escapeHtml(label)}</span>`;
			const titleAttr = title === null || title === undefined ? "" : ` title="${escapeHtml(title)}"`;
			return `<a href="${escapeHtml(href)}"${titleAttr} target="_blank" rel="noreferrer noopener">${escapeHtml(label)}</a>`;
		},
	},
});

export interface MarkdownProps {
	readonly text: string;
	readonly className?: string;
}

/** 渲染模型输出的 Markdown；链接统一交给主进程打开，禁止脚本与远程资源注入。 */
export function Markdown({ text, className }: MarkdownProps): JSX.Element {
	const html = useMemo(() => {
		const rendered = marked.parse(text, { async: false });
		return DOMPurify.sanitize(rendered, {
			USE_PROFILES: { html: true },
			ADD_ATTR: ["target", "rel"],
			FORBID_TAGS: ["style", "iframe", "object", "embed", "form", "input", "button"],
			FORBID_ATTR: ["style", "srcset", "formaction"],
		});
	}, [text]);

	const handleClick = (event: MouseEvent<HTMLDivElement>): void => {
		const anchor = (event.target as HTMLElement).closest("a");
		if (anchor === null) return;
		const href = anchor.getAttribute("href");
		if (href === null || !isSafeLink(href)) return;
		event.preventDefault();
		void window.moros.openExternal(href);
	};

	return (
		<div
			className={className === undefined ? "prose" : `prose ${className}`}
			onClick={handleClick}
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}

interface HastNode {
	readonly type: string;
	readonly value?: string;
	readonly tagName?: string;
	readonly properties?: Readonly<Record<string, unknown>>;
	readonly children?: readonly HastNode[];
}

/** lowlight 返回 hast；这里只序列化 span + class，其他标签一律丢弃。 */
function hastToHtml(root: unknown): string {
	const node = root as HastNode;
	if (node.type === "text") return escapeHtml(node.value ?? "");
	const children = (node.children ?? []).map(hastToHtml).join("");
	if (node.type !== "element" || node.tagName !== "span") return children;
	const className = node.properties?.["className"];
	const classes = Array.isArray(className)
		? className.filter((value): value is string => typeof value === "string")
		: [];
	const classAttribute = classes.length === 0 ? "" : ` class="${escapeHtml(classes.join(" "))}"`;
	return `<span${classAttribute}>${children}</span>`;
}

function isSafeLink(href: string): boolean {
	try {
		const url = new URL(href);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return href.startsWith("#");
	}
}

function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
