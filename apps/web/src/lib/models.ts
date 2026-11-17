import { MAX_VALUE, paramKind, type ModelParam } from '@contracts';

export {
  MAX_VALUE, catalogEntry, catalogParams, catalogSelection, contextChoices, isOn, maxOption, nativeFastUnavailable,
  normalizeNativeFastSelection, paramKind, paramsFromOptions, parseSelection, pickedSelection, serializeSelection, toggledValue,
} from '@contracts';
export type { ModelParam, ParamKind } from '@contracts';

// `xhigh` keeps the CLI's own token as its label; the CLI reports a friendlier
// "very high" for it, but the token is what users compare against in the CLI/TUI.
const effortLabels: Record<string, string> = { none: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'xhigh', 'extra-high': 'xhigh', max: 'Max' };

export function optionLabel(param: ModelParam, value: string): string {
  if (param.id === 'search') {
    if (value === 'true') return 'On';
    if (value === 'false') return 'Off';
  }
  if (paramKind(param) === 'effort') return effortLabels[value] ?? param.options.find((option) => option.value === value)?.label ?? value;
  return param.options.find((option) => option.value === value)?.label ?? value;
}

export function paramTitle(param: ModelParam): string {
  if (param.id === 'search') return 'Web search';
  switch (paramKind(param)) {
    case 'effort': return 'Effort';
    case 'fast': return 'Fast';
    case 'max': return 'Max';
    case 'toggle': return param.id === 'thinking' ? 'Thinking' : param.name;
    default: return param.id === 'optimize_for' ? 'Routing' : param.name;
  }
}

export function paramHint(param: ModelParam): string {
  switch (paramKind(param)) {
    case 'fast': return 'Faster responses, higher usage';
    // Max has no hint: the switch and the window strip are two rows over one parameter, and a hint
    // here only said again what the strip below it shows. The strip is hidden while Max is on, so
    // there is exactly one place that names the window at any moment.
    case 'max': return '';
    case 'toggle': return param.id === 'thinking' ? 'Reason before responding' : param.description ?? '';
    default: return '';
  }
}
