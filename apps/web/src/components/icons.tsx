import {
  Clock, Blocks, Activity, Archive, ArchiveRestore, ArrowDown, ArrowLeft, ArrowRightLeft, ArrowUp, AtSign, Bookmark, BookmarkMinus, BookmarkPlus,
  Bot, Brain, ChartColumn, ChevronRight, Circle, CircleDashed, CircleHelp, Columns2, Copy, CornerDownLeft,
  CornerUpRight, Cpu, Dices, Download, Ellipsis, ExternalLink, Eye, File, FileCode2, FileCog, FilePenLine,
  FileText, FoldHorizontal, Folder, FolderClosed, FolderOpen, FolderPlus, Gauge, GitBranch, GitCommitHorizontal, GitCompare, GitFork,
  GitMerge, GitPullRequest, Globe, Hand, HardDriveDownload, History, Highlighter, Home, Image, ImageDown, Infinity, Info,
  KeyRound, Laptop, Layers, ListChecks, ListFilter, ListTodo, Lock, LogOut, Maximize, MemoryStick, Menu, MessageCirclePlus,
  MessageCircleQuestion, MessageSquareText, MessagesSquare, Minimize, Minus, Monitor, Moon, OctagonX, Package, PanelLeft, PanelRight,
  Paperclip, Pause, PencilLine, Pin, PinOff, Play, Plus, Repeat, RotateCw, Save,
  Search, Send, Server, Settings, Settings2, ShieldCheck, ShieldHalf, Shrink, Slash, Smartphone, Sparkle,
  Sparkles, Square, SquareArrowOutUpRight, SquareCheck, SquarePen, SquareTerminal, Star, Sun, Tag, Target, Terminal,
  Timer, Trash2, Undo2, Unlock, Upload, User, Workflow, WrapText, Wrench, Zap,
} from 'lucide-react';
import { filled, icon } from './icons-base';

/**
 * Every glyph the app uses, under the names call sites import: one family (lucide), one stroke.
 * Outlines by default; the filled ones are the on state of their outline (`…Filled`) or a
 * transport control. The ones the page needs before the workbench chunk loads are defined in
 * `icons-base.tsx` and re-exported here, so this file only loads with the workbench.
 */
export { type IconProps, IconArrowRight, IconCheck, IconChevronDown, IconCircleAlert, IconCircleCheck, IconInfo, IconLoaderCircle, IconRefreshCw, IconRotateCcw, IconTriangleAlert, IconX } from './icons-base';

export const IconActivity = icon(Activity);
export const IconArchive = icon(Archive);
export const IconArchiveRestore = icon(ArchiveRestore);
export const IconArrowsInLineHorizontal = icon(FoldHorizontal);
export const IconArrowDown = icon(ArrowDown);
export const IconArrowLeft = icon(ArrowLeft);
export const IconArrowRightLeft = icon(ArrowRightLeft);
export const IconArrowUp = icon(ArrowUp);
export const IconAtSign = icon(AtSign);
export const IconBot = icon(Bot);
export const IconBrain = icon(Brain);
export const IconChartColumn = icon(ChartColumn);
/** Scheduled work. A plain clock: the calendar-with-clock glyph turns to noise at nav size. */
export const IconCalendarClock = icon(Clock);
export const IconChevronRight = icon(ChevronRight);
export const IconCircle = icon(Circle);
export const IconCircleDashed = icon(CircleDashed);
export const IconCircleHelp = icon(CircleHelp);
export const IconCopy = icon(Copy);
export const IconCompress = icon(Shrink);
export const IconCpu = icon(Cpu);
export const IconGauge = icon(Gauge);
export const IconMemoryStick = icon(MemoryStick);
export const IconTimer = icon(Timer);
export const IconCornerDownLeft = icon(CornerDownLeft);
export const IconDices = icon(Dices);
export const IconDownload = icon(Download);
export const IconHistory = icon(History);
export const IconListFilter = icon(ListFilter);
export const IconEllipsis = icon(Ellipsis);
export const IconExternalLink = icon(ExternalLink);
export const IconEye = icon(Eye);
export const IconFile = icon(File);
export const IconFileCode2 = icon(FileCode2);
export const IconFileCog = icon(FileCog);
export const IconFilePenLine = icon(FilePenLine);
export const IconFileText = icon(FileText);
export const IconFolder = icon(Folder);
export const IconFolderClosed = icon(FolderClosed);
export const IconFolderOpen = icon(FolderOpen);
export const IconFolderPlus = icon(FolderPlus);
export const IconGitBranch = icon(GitBranch);
/** The conversation canvas: nodes and the edges between them. */
export const IconGraph = icon(Workflow);
export const IconGitCompare = icon(GitCompare);
export const IconGitCommitHorizontal = icon(GitCommitHorizontal);
export const IconGitFork = icon(GitFork);
export const IconGitMerge = icon(GitMerge);
export const IconGitPullRequest = icon(GitPullRequest);
export const IconGlobe = icon(Globe);
export const IconHand = icon(Hand);
export const IconHardDriveDownload = icon(HardDriveDownload);
export const IconHome = icon(Home);
export const IconImage = icon(Image);
export const IconImageDown = icon(ImageDown);
export const IconInfinity = icon(Infinity);
export const IconInfoOutline = icon(Info);
export const IconKey = icon(KeyRound);
export const IconLaptop = icon(Laptop);
export const IconLayers = icon(Layers);
export const IconListChecks = icon(ListChecks);
export const IconListTodo = icon(ListTodo);
export const IconLock = icon(Lock);
export const IconLogOut = icon(LogOut);
export const IconMenu = icon(Menu);
export const IconMessageCircleQuestion = icon(MessageCircleQuestion);
export const IconMessagesSquare = icon(MessagesSquare);
export const IconMaximize = icon(Maximize);
export const IconMinimize = icon(Minimize);
export const IconMinus = icon(Minus);
export const IconMonitor = icon(Monitor);
export const IconSmartphone = icon(Smartphone);
export const IconMoon = icon(Moon);
export const IconOctagonX = icon(OctagonX);
export const IconPanelLeft = icon(PanelLeft);
export const IconPanelRight = icon(PanelRight);
export const IconPaperclip = icon(Paperclip);
export const IconPencilLine = icon(PencilLine);
export const IconPin = icon(Pin);
export const IconPinOff = icon(PinOff);
export const IconPause = filled(Pause);
export const IconPlay = filled(Play);
export const IconPlus = icon(Plus);
/** Plugins. Blocks that fit together read cleaner at 16-18px than the jigsaw outline. */
export const IconPuzzle = icon(Blocks);
export const IconRepeat = icon(Repeat);
export const IconRotateCw = icon(RotateCw);
export const IconSave = icon(Save);
export const IconSearch = icon(Search);
export const IconServer = icon(Server);
export const IconSettings = icon(Settings);
export const IconSettings2 = icon(Settings2);
export const IconShieldCheck = icon(ShieldCheck);
export const IconShieldHalf = icon(ShieldHalf);
export const IconSlash = icon(Slash);
/** One agent at work, on the canvas; [IconSparkles] stands for the subagents it starts. */
export const IconSparkle = icon(Sparkle);
export const IconSparkles = icon(Sparkles);
/** The stop control, wherever a run can be stopped. */
export const IconSquare = filled(Square);
export const IconSquareArrowOutUpRight = icon(SquareArrowOutUpRight);
export const IconSquarePen = icon(SquarePen);
export const IconMessageCirclePlus = icon(MessageCirclePlus);
/** Commands, background tasks and native sessions; `IconTerminal` is the shell itself. */
export const IconSquareTerminal = icon(SquareTerminal);
export const IconStar = icon(Star);
export const IconStarFilled = filled(Star);
export const IconSun = icon(Sun);
export const IconTag = icon(Tag);
export const IconTarget = icon(Target);
export const IconTerminal = icon(Terminal);
export const IconTrash2 = icon(Trash2);
export const IconUndo2 = icon(Undo2);
export const IconUnlock = icon(Unlock);
export const IconUpload = icon(Upload);
export const IconUser = icon(User);
export const IconWrapText = icon(WrapText);
export const IconWrench = icon(Wrench);
export const IconZap = icon(Zap);
export const IconZapFilled = filled(Zap);
export const IconCornerUpRight = icon(CornerUpRight);
export const IconMessageSquareText = icon(MessageSquareText);
export const IconSend = icon(Send);
export const IconBookmarkPlus = icon(BookmarkPlus);
/** 收藏. Pins belong to pinned conversations; a mark is always a bookmark. */
export const IconBookmark = icon(Bookmark);
export const IconBookmarkFilled = filled(Bookmark);
export const IconBookmarkMinus = icon(BookmarkMinus);
export const IconHighlighter = icon(Highlighter);
export const IconSquareCheck = icon(SquareCheck);
export const IconColumns2 = icon(Columns2);
export const IconPackage = icon(Package);
