import type { JSX, ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...props }: IconProps & { children: ReactNode }): JSX.Element {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			{...props}
		>
			{children}
		</svg>
	);
}

export function PlusIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M12 5v14M5 12h14" />
		</Icon>
	);
}

export function PanelIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<rect x="3" y="4" width="18" height="16" rx="2" />
			<path d="M9 4v16" />
		</Icon>
	);
}

export function FolderIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.8A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
		</Icon>
	);
}

export function FolderOpenIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
		</Icon>
	);
}

export function FileIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M6 3h8l4 4v14H6Z" />
			<path d="M14 3v4h4M9 12h6M9 16h6" />
		</Icon>
	);
}

export function SettingsIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
			<circle cx="12" cy="12" r="3" />
		</Icon>
	);
}

export function SendIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M22 2 11 13" />
			<path d="M22 2 15 22l-4-9-9-4Z" />
		</Icon>
	);
}

export function StopIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />
		</Icon>
	);
}

export function PaperclipIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="m21.4 11.6-8.5 8.5a6 6 0 0 1-8.5-8.5l8.5-8.5a4 4 0 0 1 5.7 5.7l-8.5 8.5a2 2 0 0 1-2.8-2.8l7.8-7.8" />
		</Icon>
	);
}

export function ChevronRightIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="m9 18 6-6-6-6" />
		</Icon>
	);
}

export function ChevronDownIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="m6 9 6 6 6-6" />
		</Icon>
	);
}

export function SparklesIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="m12 3 1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8Z" />
			<path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z" />
		</Icon>
	);
}

export function LightbulbIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
			<path d="M9 18h6M10 22h4" />
		</Icon>
	);
}

export function TerminalIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="m5 7 5 5-5 5M12 17h7" />
		</Icon>
	);
}

export function BranchIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<circle cx="6" cy="5" r="2" />
			<circle cx="18" cy="6" r="2" />
			<circle cx="6" cy="19" r="2" />
			<path d="M6 7v10M18 8c0 4-6 4-6 8" />
		</Icon>
	);
}

export function MessageIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-7a8 8 0 1 1 18-4Z" />
		</Icon>
	);
}

export function SearchIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<circle cx="11" cy="11" r="7" />
			<path d="m20 20-3.5-3.5" />
		</Icon>
	);
}

export function XIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M6 6l12 12M18 6 6 18" />
		</Icon>
	);
}

export function RefreshIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M20 11a8 8 0 0 0-14.7-4L3 10M3 4v6h6M4 13a8 8 0 0 0 14.7 4L21 14M21 20v-6h-6" />
		</Icon>
	);
}

export function AlertIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M10.3 3.9 2.2 18a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
			<path d="M12 9v4M12 17h.01" />
		</Icon>
	);
}

export function CheckIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="m5 12 4 4L19 6" />
		</Icon>
	);
}

export function ClockIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v5l3 2" />
		</Icon>
	);
}

export function ImageIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<rect x="3" y="4" width="18" height="16" rx="2" />
			<circle cx="9" cy="10" r="1.5" />
			<path d="m21 15-4-4-8 9" />
		</Icon>
	);
}

export function SlidersIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
			<circle cx="16" cy="6" r="2" />
			<circle cx="10" cy="12" r="2" />
			<circle cx="18" cy="18" r="2" />
		</Icon>
	);
}

export function ArchiveIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<rect x="3" y="4" width="18" height="4" rx="1" />
			<path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
		</Icon>
	);
}

export function DownloadIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
		</Icon>
	);
}

export function TrashIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5" />
		</Icon>
	);
}

export function ForkIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<circle cx="6" cy="5" r="2" />
			<circle cx="18" cy="5" r="2" />
			<circle cx="12" cy="19" r="2" />
			<path d="M6 7v2a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4V7M12 13v4" />
		</Icon>
	);
}

export function EyeIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
			<circle cx="12" cy="12" r="3" />
		</Icon>
	);
}

export function EyeOffIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.2A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3.2M6.3 6.3C3.6 8 2 12 2 12s3.5 7 10 7a10.7 10.7 0 0 0 5.7-1.7" />
		</Icon>
	);
}

export function SunIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<circle cx="12" cy="12" r="4" />
			<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
		</Icon>
	);
}

export function MoonIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" />
		</Icon>
	);
}

export function MoreIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<circle cx="5" cy="12" r="1" fill="currentColor" />
			<circle cx="12" cy="12" r="1" fill="currentColor" />
			<circle cx="19" cy="12" r="1" fill="currentColor" />
		</Icon>
	);
}

export function ListTreeIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
		</Icon>
	);
}

export function DiffIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M6 3v12a3 3 0 0 0 3 3h7M6 3 3 6M6 3l3 3M18 21l3-3M18 21l-3-3M12 9h6M12 13h4" />
		</Icon>
	);
}

export function FolderPlusIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
			<path d="M12 11v6M9 14h6" />
		</Icon>
	);
}

export function LinkIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M10 13a5 5 0 0 0 7.1 0l2.8-2.8a5 5 0 0 0-7.1-7.1L11 5" />
			<path d="M14 11a5 5 0 0 0-7.1 0L4.1 13.8a5 5 0 0 0 7.1 7.1L13 19" />
		</Icon>
	);
}

export function MinusIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M5 12h14" />
		</Icon>
	);
}

export function MaximizeIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<rect x="4" y="4" width="16" height="16" rx="1.5" />
		</Icon>
	);
}

export function RestoreIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<rect x="8" y="8" width="12" height="12" rx="1.5" />
			<path d="M4 16V5a1 1 0 0 1 1-1h11" />
		</Icon>
	);
}

export function ChevronLeftIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="m15 18-6-6 6-6" />
		</Icon>
	);
}

export function ShieldIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67 0C7.49 20.5 4 18 4 13V5a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 2.8 17 4 19 4a1 1 0 0 1 1 1Z" />
		</Icon>
	);
}

export function PointerIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M22 14a8 8 0 0 1-8 8" />
			<path d="M18 11v-1a2 2 0 0 0-2-2a2 2 0 0 0-2 2" />
			<path d="M14 10V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v1" />
			<path d="M10 9.5V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v10" />
			<path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
		</Icon>
	);
}

export function ShieldCheckIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67 0C7.49 20.5 4 18 4 13V5a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 2.8 17 4 19 4a1 1 0 0 1 1 1Z" />
			<path d="m9 12 2 2 4-4" />
		</Icon>
	);
}

export function ShieldAlertIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67 0C7.49 20.5 4 18 4 13V5a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 2.8 17 4 19 4a1 1 0 0 1 1 1Z" />
			<path d="M12 8v4M12 16h.01" />
		</Icon>
	);
}

export function ArrowUpIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M12 19V5M5 12l7-7 7 7" />
		</Icon>
	);
}

export function ArrowLeftIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M19 12H5M12 19l-7-7 7-7" />
		</Icon>
	);
}

export function ArrowRightIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M5 12h14M12 5l7 7-7 7" />
		</Icon>
	);
}

export function MessagePlusIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" />
			<path d="M8 12h8" />
			<path d="M12 8v8" />
		</Icon>
	);
}

/* 设置导航图标：按纵向列表语义补充，沿用统一 Icon 包装 */

export function SlidersHorizontalIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M10 5H3" />
			<path d="M12 19H3" />
			<path d="M14 3v4" />
			<path d="M16 17v4" />
			<path d="M21 12h-9" />
			<path d="M21 19h-5" />
			<path d="M21 5h-7" />
			<path d="M8 10v4" />
			<path d="M8 12H3" />
		</Icon>
	);
}

export function PaletteIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z" />
			<circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
			<circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
			<circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
			<circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
		</Icon>
	);
}

export function UserCogIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M10 15H6a4 4 0 0 0-4 4v2" />
			<path d="m14.305 16.53.923-.382" />
			<path d="m15.228 13.852-.923-.383" />
			<path d="m16.852 12.228-.383-.923" />
			<path d="m16.852 17.772-.383.924" />
			<path d="m19.148 12.228.383-.923" />
			<path d="m19.53 18.696-.382-.924" />
			<path d="m20.772 13.852.924-.383" />
			<path d="m20.772 16.148.924.383" />
			<circle cx="18" cy="15" r="3" />
			<circle cx="9" cy="7" r="4" />
		</Icon>
	);
}

export function KeyboardIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<rect x="2" y="5" width="20" height="14" rx="2" />
			<path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M8 16h8" />
		</Icon>
	);
}

export function BrainIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M12 5a3 3 0 0 0-6 0 3 3 0 0 0-1 5.8A3 3 0 0 0 6 17a3 3 0 0 0 6 1zM12 5a3 3 0 0 1 6 0 3 3 0 0 1 1 5.8A3 3 0 0 1 18 17a3 3 0 0 1-6 1z" />
		</Icon>
	);
}

export function PuzzleIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M10 4a2 2 0 1 1 4 0v1h3a1 1 0 0 1 1 1v3h1a2 2 0 1 1 0 4h-1v3a1 1 0 0 1-1 1h-3v-1a2 2 0 1 0-4 0v1H6a1 1 0 0 1-1-1v-3H4a2 2 0 1 1 0-4h1V6a1 1 0 0 1 1-1h4z" />
		</Icon>
	);
}

export function PlugIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M9 3v6M15 3v6M7 9h10v3a5 5 0 0 1-10 0zM12 17v4" />
		</Icon>
	);
}

export function MonitorIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<rect x="2" y="4" width="20" height="13" rx="2" />
			<path d="M8 21h8M12 17v4" />
		</Icon>
	);
}

export function DatabaseIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<ellipse cx="12" cy="5" rx="8" ry="3" />
			<path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
		</Icon>
	);
}

export function BookIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2z" />
			<path d="M8 7h6M8 11h6" />
		</Icon>
	);
}

export function RouteIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<circle cx="6" cy="19" r="3" />
			<circle cx="18" cy="5" r="3" />
			<path d="M6 16V9a3 3 0 0 1 3-3h3a3 3 0 0 0 3-3" />
		</Icon>
	);
}

export function ShareIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<circle cx="18" cy="5" r="3" />
			<circle cx="6" cy="12" r="3" />
			<circle cx="18" cy="19" r="3" />
			<path d="M8.6 10.5l6.8-4M8.6 13.5l6.8 4" />
		</Icon>
	);
}

export function CubeIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M12 2.5 21 7v10l-9 4.5L3 17V7Z" />
			<path d="m3 7 9 4.5L21 7M12 11.5V21.5" />
		</Icon>
	);
}

export function ServerIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<rect x="3" y="4" width="18" height="7" rx="2" />
			<rect x="3" y="13" width="18" height="7" rx="2" />
			<path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6" />
		</Icon>
	);
}

/** Meta 品牌 ∞ 标志（来自 @lobehub/icons，用作应用标识）。 */
export function MetaIcon(props: IconProps): JSX.Element {
	return (
		<svg
			width={props.size ?? 24}
			height={props.size ?? 24}
			viewBox="0 0 24 24"
			fill="currentColor"
			aria-hidden="true"
			{...props}
		>
			<title>Meta</title>
			<path d="M6.897 4c1.915 0 3.516.932 5.43 3.376l.282-.373c.19-.246.383-.484.58-.71l.313-.35C14.588 4.788 15.792 4 17.225 4c1.273 0 2.469.557 3.491 1.516l.218.213c1.73 1.765 2.917 4.71 3.053 8.026l.011.392.002.25c0 1.501-.28 2.759-.818 3.7l-.14.23-.108.153c-.301.42-.664.758-1.086 1.009l-.265.142-.087.04a3.493 3.493 0 01-.302.118 4.117 4.117 0 01-1.33.208c-.524 0-.996-.067-1.438-.215-.614-.204-1.163-.56-1.726-1.116l-.227-.235c-.753-.812-1.534-1.976-2.493-3.586l-1.43-2.41-.544-.895-1.766 3.13-.343.592C7.597 19.156 6.227 20 4.356 20c-1.21 0-2.205-.42-2.936-1.182l-.168-.184c-.484-.573-.837-1.311-1.043-2.189l-.067-.32a8.69 8.69 0 01-.136-1.288L0 14.468c.002-.745.06-1.49.174-2.23l.1-.573c.298-1.53.828-2.958 1.536-4.157l.209-.34c1.177-1.83 2.789-3.053 4.615-3.16L6.897 4zm-.033 2.615l-.201.01c-.83.083-1.606.673-2.252 1.577l-.138.199-.01.018c-.67 1.017-1.185 2.378-1.456 3.845l-.004.022a12.591 12.591 0 00-.207 2.254l.002.188c.004.18.017.36.04.54l.043.291c.092.503.257.908.486 1.208l.117.137c.303.323.698.492 1.17.492 1.1 0 1.796-.676 3.696-3.641l2.175-3.4.454-.701-.139-.198C9.11 7.3 8.084 6.616 6.864 6.616zm10.196-.552l-.176.007c-.635.048-1.223.359-1.82.933l-.196.198c-.439.462-.887 1.064-1.367 1.807l.266.398c.18.274.362.56.55.858l.293.475 1.396 2.335.695 1.114c.583.926 1.03 1.6 1.408 2.082l.213.262c.282.326.529.54.777.673l.102.05c.227.1.457.138.718.138.176.002.35-.023.518-.073.338-.104.61-.32.813-.637l.095-.163.077-.162c.194-.459.29-1.06.29-1.785l-.006-.449c-.08-2.871-.938-5.372-2.2-6.798l-.176-.189c-.67-.683-1.444-1.074-2.27-1.074z" />
		</svg>
	);
}

export function InfoIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 11v5M12 8h.01" />
		</Icon>
	);
}

export function PencilIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="m15 5 4 4M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10Z" />
		</Icon>
	);
}

export function ArchiveIcon2(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<rect x="3" y="4" width="18" height="4" rx="1" />
			<path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
		</Icon>
	);
}
