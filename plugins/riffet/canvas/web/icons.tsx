import { Icon, type PluginIconName } from '@riffet/plugin-web';

/** The host's icons by the names the canvas uses, as components, so a glyph reads `<IconCopy />` where it is drawn. */
const named = (name: PluginIconName) => function NamedIcon({ className }: { className?: string }) {
  return <Icon name={name} {...(className ? { className } : {})} />;
};

/** The host has no arrow-up icon by name yet (the chat composer's send mark): drawn here in the same stroke as its set. */
export function IconArrowUp({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...(className ? { className } : {})}>
      <path d="m5 12 7-7 7 7" /><path d="M12 19V5" />
    </svg>
  );
}
export const IconArrowRightLeft = named('arrow-right-left');
export const IconArrowsInLineHorizontal = named('arrows-in-line-horizontal');
export const IconBrain = named('brain');
export const IconCalendarClock = named('calendar-clock');
export const IconCheck = named('check');
export const IconChevronDown = named('chevron-down');
export const IconCircle = named('circle');
export const IconCircleAlert = named('circle-alert');
export const IconCircleCheck = named('circle-check');
export const IconCopy = named('copy');
export const IconFolder = named('folder');
export const IconFolderClosed = named('folder-closed');
export const IconGitBranch = named('git-branch');
export const IconGitCommitHorizontal = named('git-commit-horizontal');
export const IconGitFork = named('git-fork');
export const IconGlobe = named('globe');
export const IconInfo = named('info');
/** The host has no image icon by name yet: drawn here in the same stroke as its set. */
export function IconImage({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...(className ? { className } : {})}>
      <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </svg>
  );
}
export const IconListChecks = named('list-checks');
export const IconMaximize = named('maximize');
export const IconMessageCircleQuestion = named('message-circle-question');
export const IconMinus = named('minus');
export const IconPaperclip = named('paperclip');
export const IconPause = named('pause');
export const IconPlay = named('play');
export const IconPlus = named('plus');
export const IconSearch = named('search');
export const IconSparkle = named('sparkle');
export const IconSparkles = named('sparkles');
export const IconSquareArrowOutUpRight = named('square-arrow-out-up-right');
export const IconSquareTerminal = named('square-terminal');
export const IconTarget = named('target');
export const IconWrench = named('wrench');
export const IconX = named('x');
