import { Icon, type PluginIconName } from '@riffet/plugin-web';

/** The host's icons by the names the trace uses, as components. */
const named = (name: PluginIconName) => function NamedIcon({ className }: { className?: string }) {
  return <Icon name={name} {...(className ? { className } : {})} />;
};

export const IconActivity = named('activity');
export const IconBrain = named('brain');
export const IconChevronRight = named('chevron-right');
export const IconCircleAlert = named('circle-alert');
export const IconCopy = named('copy');
export const IconGitBranch = named('git-branch');
export const IconInfo = named('info');
export const IconMessagesSquare = named('messages-square');
export const IconRefreshCw = named('refresh-cw');
export const IconSearch = named('search');
export const IconSparkle = named('sparkle');
export const IconSquareArrowOutUpRight = named('square-arrow-out-up-right');
export const IconX = named('x');
export const IconMaximize = named('maximize');
export const IconMinus = named('minus');
export const IconPlus = named('plus');
