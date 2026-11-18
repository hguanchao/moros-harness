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
			strokeWidth="1.7"
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
			<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
		</Icon>
	);
}

export function FolderOpenIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1" />
			<path d="M4.5 20h13.2a2 2 0 0 0 1.9-1.4l1.7-5.6a1 1 0 0 0-1-1.3H7.3a2 2 0 0 0-1.9 1.4L3 20Z" />
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
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
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

export function ArrowUpIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M12 19V5M5 12l7-7 7 7" />
		</Icon>
	);
}

export function MessagePlusIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
			<path d="M12 7v6M9 10h6" />
		</Icon>
	);
}

export function PanelRightIcon(props: IconProps): JSX.Element {
	return (
		<Icon {...props}>
			<rect x="3" y="3" width="18" height="18" rx="2" />
			<path d="M15 3v18" />
		</Icon>
	);
}
