import type { IconComponent, PluginIconName } from '@riffet/plugin-web';
import {
  IconActivity, IconArrowRightLeft, IconArrowsInLineHorizontal, IconBrain, IconCalendarClock, IconCheck, IconChevronDown, IconChevronRight, IconCircle, IconCircleAlert, IconCircleCheck, IconCopy,
  IconFileCode2, IconFolder, IconFolderClosed, IconGitBranch, IconGitCommitHorizontal, IconGitCompare, IconGitFork, IconGlobe, IconGraph, IconInfo, IconListChecks, IconMaximize,
  IconMessageCircleQuestion, IconMessagesSquare, IconMinus, IconPaperclip, IconPause, IconPanelRight, IconPlay, IconPlus, IconRefreshCw, IconSave, IconSearch, IconSparkle, IconSparkles,
  IconSquareArrowOutUpRight, IconSquareTerminal, IconTarget, IconWrench, IconX, IconListFilter, IconHistory, IconChevronsDownUp, IconCaseSensitive, IconWholeWord, IconRegex,
  IconArrowLeft, IconArrowRight, IconPanelLeft, IconPackage, IconFolderDot, IconFolderCode, IconFolderKanban, IconFolderArchive, IconFolderCog, IconTextQuote, IconServer,
  IconFile, IconFileSearch, IconFolderSearch, IconFolderOpen, IconListTree, IconArrowUpRight, IconLink, IconTextSelect, IconPin, IconMinimize,
  IconRotateCcw, IconCopyX, IconArrowRightToLine, IconSquareX, IconChevronsUpDown, IconHash,
  IconFilePlus, IconFolderPlus, IconPencilLine, IconTrash2, IconUndo2, IconLock, IconWrapText, IconColumns2,
} from '@/components/icons';

/** What each name of the plugin SDK's icon vocabulary draws. */
const ICONS: Record<PluginIconName, IconComponent> = {
  activity: IconActivity, 'arrow-right-left': IconArrowRightLeft, 'arrows-in-line-horizontal': IconArrowsInLineHorizontal, brain: IconBrain, 'calendar-clock': IconCalendarClock,
  check: IconCheck, 'chevron-down': IconChevronDown, 'chevron-right': IconChevronRight, circle: IconCircle, 'circle-alert': IconCircleAlert, 'circle-check': IconCircleCheck, copy: IconCopy,
  'file-code': IconFileCode2, 'panel-right': IconPanelRight, folder: IconFolder, 'folder-closed': IconFolderClosed, 'git-branch': IconGitBranch, 'git-commit-horizontal': IconGitCommitHorizontal,
  'git-compare': IconGitCompare, 'git-fork': IconGitFork, globe: IconGlobe, graph: IconGraph, info: IconInfo, 'list-checks': IconListChecks,
  maximize: IconMaximize, 'message-circle-question': IconMessageCircleQuestion, 'messages-square': IconMessagesSquare, minus: IconMinus,
  paperclip: IconPaperclip, pause: IconPause, play: IconPlay, plus: IconPlus, 'refresh-cw': IconRefreshCw, save: IconSave, search: IconSearch, sparkle: IconSparkle, sparkles: IconSparkles,
  'square-arrow-out-up-right': IconSquareArrowOutUpRight, 'square-terminal': IconSquareTerminal, target: IconTarget, wrench: IconWrench, x: IconX,
  'list-filter': IconListFilter, history: IconHistory, 'chevrons-down-up': IconChevronsDownUp, 'case-sensitive': IconCaseSensitive, 'whole-word': IconWholeWord, regex: IconRegex,
  'arrow-left': IconArrowLeft, 'arrow-right': IconArrowRight, 'panel-left': IconPanelLeft, package: IconPackage, 'folder-dot': IconFolderDot, 'folder-code': IconFolderCode,
  'folder-kanban': IconFolderKanban, 'folder-archive': IconFolderArchive, 'folder-cog': IconFolderCog, 'text-quote': IconTextQuote, server: IconServer,
  file: IconFile, 'file-search': IconFileSearch, 'folder-search': IconFolderSearch, 'folder-open': IconFolderOpen, 'list-tree': IconListTree, 'arrow-up-right': IconArrowUpRight,
  link: IconLink, 'text-select': IconTextSelect, pin: IconPin, minimize: IconMinimize, 'rotate-ccw': IconRotateCcw, 'copy-x': IconCopyX, 'arrow-right-to-line': IconArrowRightToLine,
  'square-x': IconSquareX, 'chevrons-up-down': IconChevronsUpDown, hash: IconHash,
  'file-plus': IconFilePlus, 'folder-plus': IconFolderPlus, 'pencil-line': IconPencilLine, 'trash-2': IconTrash2, 'undo-2': IconUndo2, lock: IconLock, 'wrap-text': IconWrapText, 'columns-2': IconColumns2,
};

export const pluginIcon = (name: PluginIconName): IconComponent => ICONS[name] ?? IconWrench;
