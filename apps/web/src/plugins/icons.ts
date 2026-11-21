import type { IconComponent, PluginIconName } from '@riffet/plugin-web';
import {
  IconActivity, IconArrowRightLeft, IconArrowsInLineHorizontal, IconBrain, IconCalendarClock, IconCheck, IconChevronDown, IconChevronRight, IconCircle, IconCircleAlert, IconCircleCheck, IconCopy,
  IconFolder, IconFolderClosed, IconGitBranch, IconGitCommitHorizontal, IconGitCompare, IconGitFork, IconGlobe, IconGraph, IconInfo, IconListChecks, IconMaximize,
  IconMessageCircleQuestion, IconMessagesSquare, IconMinus, IconPaperclip, IconPause, IconPlay, IconPlus, IconRefreshCw, IconSave, IconSearch, IconSparkle, IconSparkles,
  IconSquareArrowOutUpRight, IconSquareTerminal, IconTarget, IconWrench, IconX,
} from '@/components/icons';

/** What each name of the plugin SDK's icon vocabulary draws. */
const ICONS: Record<PluginIconName, IconComponent> = {
  activity: IconActivity, 'arrow-right-left': IconArrowRightLeft, 'arrows-in-line-horizontal': IconArrowsInLineHorizontal, brain: IconBrain, 'calendar-clock': IconCalendarClock,
  check: IconCheck, 'chevron-down': IconChevronDown, 'chevron-right': IconChevronRight, circle: IconCircle, 'circle-alert': IconCircleAlert, 'circle-check': IconCircleCheck, copy: IconCopy,
  folder: IconFolder, 'folder-closed': IconFolderClosed, 'git-branch': IconGitBranch, 'git-commit-horizontal': IconGitCommitHorizontal,
  'git-compare': IconGitCompare, 'git-fork': IconGitFork, globe: IconGlobe, graph: IconGraph, info: IconInfo, 'list-checks': IconListChecks,
  maximize: IconMaximize, 'message-circle-question': IconMessageCircleQuestion, 'messages-square': IconMessagesSquare, minus: IconMinus,
  paperclip: IconPaperclip, pause: IconPause, play: IconPlay, plus: IconPlus, 'refresh-cw': IconRefreshCw, save: IconSave, search: IconSearch, sparkle: IconSparkle, sparkles: IconSparkles,
  'square-arrow-out-up-right': IconSquareArrowOutUpRight, 'square-terminal': IconSquareTerminal, target: IconTarget, wrench: IconWrench, x: IconX,
};

export const pluginIcon = (name: PluginIconName): IconComponent => ICONS[name] ?? IconWrench;
