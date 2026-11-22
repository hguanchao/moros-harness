import type { JSX, SVGProps } from "react";
import {
	Archive,
	ArrowDown,
	ArrowLeft,
	ArrowRight,
	ArrowUp,
	Book,
	Box,
	Brain,
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	CircleCheck,
	CircleHelp,
	CircleX,
	Clock,
	Copy,
	Database,
	Diff,
	Download,
	Ellipsis,
	Eye,
	EyeOff,
	File,
	FileText,
	Folder,
	FolderOpen,
	FolderPlus,
	GitBranch,
	GitFork,
	Globe,
	Image,
	Info,
	Keyboard,
	Lightbulb,
	Link,
	ListChecks,
	ListChevronsDownUp,
	ListChevronsUpDown,
	ListTree,
	MessageCircle,
	MessageCirclePlus,
	Minus,
	Monitor,
	Moon,
	Palette,
	Paperclip,
	PanelLeft,
	PanelRight,
	Pencil,
	Pin,
	PinOff,
	Plug,
	Play,
	Plus,
	Pointer,
	Puzzle,
	RefreshCw,
	Route,
	Search,
	Send,
	Server,
	Settings,
	Share2,
	Shield,
	ShieldAlert,
	ShieldCheck,
	SlidersHorizontal,
	SlidersVertical,
	Sparkles,
	Square,
	Sun,
	Terminal,
	Trash2,
	TriangleAlert,
	UserCog,
	Video,
	X,
	type LucideIcon,
} from "lucide-react";

/** 统一图标 props：lucide 原生 props 加一个简写的 size 语义（lucide 本身也支持 size）。 */
export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

/**
 * 图标统一走 lucide 官方组件，保证描边、比例与 @lucide/icons 官网一致。
 * 所有导出名保持向后兼容（沿用历史手写图标的命名），仅替换内部实现。
 */
function wrap(Lucide: LucideIcon): (props: IconProps) => JSX.Element {
	return function WrappedIcon({ size = 16, ...props }: IconProps): JSX.Element {
		return <Lucide size={size} strokeWidth={2} aria-hidden="true" {...props} />;
	};
}

export const PlusIcon = wrap(Plus);
export const PanelIcon = wrap(PanelLeft);
export const PanelRightIcon = wrap(PanelRight);
export const FolderIcon = wrap(Folder);
export const FolderOpenIcon = wrap(FolderOpen);
export const FileIcon = wrap(File);
export const FileTextIcon = wrap(FileText);
export const SettingsIcon = wrap(Settings);
export const SendIcon = wrap(Send);
export const StopIcon = wrap(Square);
export const PaperclipIcon = wrap(Paperclip);
export const ChevronRightIcon = wrap(ChevronRight);
export const ChevronDownIcon = wrap(ChevronDown);
export const SparklesIcon = wrap(Sparkles);
export const LightbulbIcon = wrap(Lightbulb);
export const TerminalIcon = wrap(Terminal);
export const BranchIcon = wrap(GitBranch);
export const MessageIcon = wrap(MessageCircle);
export const SearchIcon = wrap(Search);
export const XIcon = wrap(X);
export const RefreshIcon = wrap(RefreshCw);
export const AlertIcon = wrap(TriangleAlert);
export const CheckIcon = wrap(Check);
export const CircleCheckIcon = wrap(CircleCheck);
export const CircleXIcon = wrap(CircleX);
export const PlayIcon = wrap(Play);
export const ClockIcon = wrap(Clock);
export const ImageIcon = wrap(Image);
export const VideoIcon = wrap(Video);
export const SlidersIcon = wrap(SlidersHorizontal);
export const ArchiveIcon = wrap(Archive);
export const DownloadIcon = wrap(Download);
export const TrashIcon = wrap(Trash2);
export const ForkIcon = wrap(GitFork);
export const EyeIcon = wrap(Eye);
export const EyeOffIcon = wrap(EyeOff);
export const SunIcon = wrap(Sun);
export const MoonIcon = wrap(Moon);
export const MoreIcon = wrap(Ellipsis);
export const ListTreeIcon = wrap(ListTree);
export const ListChecksIcon = wrap(ListChecks);
export const ListChevronsDownUpIcon = wrap(ListChevronsDownUp);
export const ListChevronsUpDownIcon = wrap(ListChevronsUpDown);
export const DiffIcon = wrap(Diff);
export const FolderPlusIcon = wrap(FolderPlus);
export const GlobeIcon = wrap(Globe);
export const LinkIcon = wrap(Link);
export const MinusIcon = wrap(Minus);
export const MaximizeIcon = wrap(Square);
export const RestoreIcon = wrap(Copy);
export const ChevronLeftIcon = wrap(ChevronLeft);
export const ShieldIcon = wrap(Shield);
export const PointerIcon = wrap(Pointer);
export const ShieldCheckIcon = wrap(ShieldCheck);
export const ShieldAlertIcon = wrap(ShieldAlert);
export const ArrowUpIcon = wrap(ArrowUp);
export const ArrowDownIcon = wrap(ArrowDown);
export const ArrowLeftIcon = wrap(ArrowLeft);
export const ArrowRightIcon = wrap(ArrowRight);
export const MessagePlusIcon = wrap(MessageCirclePlus);
export const SlidersHorizontalIcon = wrap(SlidersHorizontal);
export const PaletteIcon = wrap(Palette);
export const UserCogIcon = wrap(UserCog);
export const KeyboardIcon = wrap(Keyboard);
export const BrainIcon = wrap(Brain);
export const PuzzleIcon = wrap(Puzzle);
export const PlugIcon = wrap(Plug);
export const MonitorIcon = wrap(Monitor);
export const DatabaseIcon = wrap(Database);
export const BookIcon = wrap(Book);
export const RouteIcon = wrap(Route);
export const ShareIcon = wrap(Share2);
export const CubeIcon = wrap(Box);
export const ServerIcon = wrap(Server);
export const InfoIcon = wrap(Info);
export const HelpCircleIcon = wrap(CircleHelp);
export const PencilIcon = wrap(Pencil);
export const ArchiveIcon2 = wrap(Archive);
export const PinIcon = wrap(Pin);
export const PinOffIcon = wrap(PinOff);
export const CopyIcon = wrap(Copy);

/** Meta 品牌 ∞ 标志（来自 @lobehub/icons，用作应用标识；lucide 无此品牌图标）。 */
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
