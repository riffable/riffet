import type { DeviceCapability } from '../../../../packages/contracts/src/index.js';
import type { PublicDevice } from '../auth.js';
import { AppError } from '../errors.js';
import { deviceObserveDescription, screenRules } from '../prompts/index.js';
import type { DeviceTool } from './service.js';

/*
 * T1 phone control (docs/DEVICES.md §3「协议（R3，T1）」): the screen tools, their argument
 * allowlists and the guide `device_help` returns. Only the fields listed here reach the device;
 * the device's own gate (§5) decides what may run, never anything the agent passes.
 */

const SCREEN_CAPABILITIES: readonly DeviceCapability[] = ['screen.observe', 'screen.act', 'app.launch'];

/** Whether a device gets the screen tools: by platform, which does not change, so the tool list stays stable. */
export const isScreenDevice = (device: PublicDevice) => device.platform === 'android' || (device.capabilities ?? []).some(item => SCREEN_CAPABILITIES.includes(item));

export const SCREEN_ERRORS = 'DEVICE_LOCKED (ask the user to unlock), DEVICE_STOPPED (the owner pressed stop or touched the screen: end the task, ask the user), DEVICE_HANDOFF_REQUIRED (only the owner may do it: tell the user, do not retry)';

const STEP_ACTIONS = ['tap', 'long_press', 'type', 'swipe', 'scroll', 'back', 'home', 'wait_stable'] as const;
const DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
const REF = /^@e\d{1,6}$/;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const MAX_STEPS = 20;

const invalid = (message: string) => new AppError('INVALID_ARGUMENT', message);
const given = (value: unknown) => value !== undefined && value !== null;

function str(value: unknown, name: string, max: number, pattern?: RegExp): string | undefined {
  if (!given(value)) return undefined;
  if (typeof value !== 'string' || value.length > max) throw invalid(`${name} must be a string of at most ${max} characters`);
  if (pattern && !pattern.test(value)) throw invalid(`${name} is not valid`);
  return value;
}
function int(value: unknown, name: string, min: number, max: number): number | undefined {
  if (!given(value)) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
function bool(value: unknown, name: string): boolean | undefined {
  if (!given(value)) return undefined;
  if (typeof value !== 'boolean') throw invalid(`${name} must be true or false`);
  return value;
}
function oneOf<T extends string>(value: unknown, name: string, options: readonly T[]): T | undefined {
  if (!given(value)) return undefined;
  if (!options.includes(value as T)) throw invalid(`${name} must be one of ${options.join(', ')}`);
  return value as T;
}

/** One step, rebuilt from the fields its action uses; anything else the agent sent is dropped. */
function step(raw: unknown, index: number): Record<string, unknown> {
  const at = `steps[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid(`${at} must be an object`);
  const input = raw as Record<string, unknown>;
  const action = oneOf(input.action, `${at}.action`, STEP_ACTIONS);
  if (!action) throw invalid(`${at}.action is required`);
  const ref = str(input.ref, `${at}.ref`, 8, REF);
  const x = int(input.x, `${at}.x`, 0, 999), y = int(input.y, `${at}.y`, 0, 999);
  if ((x === undefined) !== (y === undefined)) throw invalid(`${at}: give both x and y, or neither`);
  const text = str(input.text, `${at}.text`, 5000);
  const submit = bool(input.submit, `${at}.submit`);
  const direction = oneOf(input.direction, `${at}.direction`, DIRECTIONS);
  const timeoutMs = int(input.timeoutMs, `${at}.timeoutMs`, 0, 10_000);
  const refPart = ref ? { ref } : {};
  switch (action) {
    case 'tap': case 'long_press':
      if (!ref && x === undefined) throw invalid(`${at}: ${action} needs ref, or x and y`);
      return { action, ...refPart, ...(x !== undefined ? { x, y } : {}) };
    case 'type':
      if (text === undefined) throw invalid(`${at}: type needs text`);
      return { action, ...refPart, text, ...(submit !== undefined ? { submit } : {}) };
    case 'swipe': case 'scroll':
      if (!direction) throw invalid(`${at}: ${action} needs direction`);
      return { action, direction, ...refPart };
    case 'wait_stable':
      return { action, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
    default:
      return { action };
  }
}

const STEP_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['action'],
  properties: {
    action: { type: 'string', enum: STEP_ACTIONS },
    ref: { type: 'string', description: 'A node ref from the latest observation, e.g. @e12.' },
    x: { type: 'integer', minimum: 0, maximum: 999 }, y: { type: 'integer', minimum: 0, maximum: 999 },
    text: { type: 'string', description: 'type: the whole new content of the field.' },
    submit: { type: 'boolean', description: 'type: then press the keyboard\'s enter key.' },
    direction: { type: 'string', enum: DIRECTIONS, description: 'swipe: finger direction; scroll: where the content you want is.' },
    timeoutMs: { type: 'integer', minimum: 0, maximum: 10_000, description: 'wait_stable only.' },
  },
};

export const SCREEN_TOOLS: readonly DeviceTool[] = [
  {
    name: 'device_observe', capability: 'screen.observe', wait: { initial: 30, max: 120 },
    description: deviceObserveDescription(),
    properties: {
      since: { type: 'string', description: 'snapshotId of your last observation, to get a diff.' },
      includeScreenshot: { type: 'boolean', description: 'Also attach a screenshot (costs context).' },
    },
    args: input => {
      const since = str(input.since, 'since', 100), shot = bool(input.includeScreenshot, 'includeScreenshot');
      return { ...(since ? { since } : {}), ...(shot !== undefined ? { includeScreenshot: shot } : {}) };
    },
  },
  {
    name: 'device_act', capability: 'screen.act', wait: { initial: 90, max: 300 }, audit: 'act',
    description: 'Run 1–20 UI steps on the phone in order (tap, long_press, type, swipe, scroll, back, home, wait_stable); the first failure stops the batch (`stoppedAt`). Batch the steps you are sure of in one call; prefer refs over x/y; add wait_stable after launching or navigating; `observe: true` returns the screen afterwards. Each step reports an effect (place_changed, done, small_change, no_effect). Irreversible taps (send, delete, submit, order) may wait for the owner to confirm on the phone unless a device_authorize grant matches. Never try to pay or transfer money.',
    properties: {
      steps: { type: 'array', minItems: 1, maxItems: MAX_STEPS, items: STEP_SCHEMA },
      observe: { type: 'boolean', description: 'Return the screen after the steps.' },
    },
    required: ['steps'],
    args: input => {
      const steps = input.steps;
      if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_STEPS) throw invalid(`steps must list 1 to ${MAX_STEPS} steps`);
      const observe = bool(input.observe, 'observe');
      return { steps: steps.map(step), ...(observe !== undefined ? { observe } : {}) };
    },
  },
  {
    name: 'device_authorize', capability: 'screen.act', wait: { initial: 120, max: 300 }, audit: 'authorize',
    description: 'Ask the owner now, on the phone, to pre-approve one irreversible action you will do later while they are away, e.g. a scheduled message: call it while the user is around (when you schedule the wake-up), with the exact content. A later step in that app, of that kind, with the same content and within validMinutes then runs without asking; a grant is used once. Payments can never be authorized.',
    properties: {
      app: { type: 'string', description: 'Package name, e.g. com.tencent.mm.' },
      action: { type: 'string', enum: ['send', 'delete', 'submit'] },
      summary: { type: 'string', description: 'What the owner approves, in their language, at most 300 characters.' },
      content: { type: 'string', description: 'The exact text you will type, at most 5000 characters; the grant then matches only it.' },
      validMinutes: { type: 'integer', minimum: 1, maximum: 1440 },
    },
    required: ['app', 'action', 'summary', 'validMinutes'],
    args: input => {
      const app = str(input.app, 'app', 255, PACKAGE);
      if (!app) throw invalid('app is required: the package name');
      if (input.action === 'pay') throw invalid('payments are always done by the owner on the phone and cannot be authorized');
      const action = oneOf(input.action, 'action', ['send', 'delete', 'submit'] as const);
      if (!action) throw invalid('action is required');
      const summary = str(input.summary, 'summary', 300)?.trim();
      if (!summary) throw invalid('summary is required');
      const content = str(input.content, 'content', 5000);
      const validMinutes = int(input.validMinutes, 'validMinutes', 1, 1440);
      if (validMinutes === undefined) throw invalid('validMinutes is required');
      return { authorize: { app, action, summary, ...(content !== undefined ? { content } : {}), validMinutes } };
    },
  },
  {
    name: 'device_launch_app', capability: 'app.launch', wait: { initial: 30, max: 120 }, audit: 'launch',
    description: 'Open an app on the phone by package or display name (give exactly one) and wait until it is in front. foreground: false comes with frontPackage / frontApp, what is in front instead (e.g. a dual-app chooser). Then wait_stable and observe.',
    properties: { package: { type: 'string', description: 'e.g. com.tencent.mm' }, name: { type: 'string', description: 'Display name, e.g. 微信' } },
    args: input => {
      const pkg = str(input.package, 'package', 255, PACKAGE), name = str(input.name, 'name', 200)?.trim();
      if (Boolean(pkg) === Boolean(name)) throw invalid('Give exactly one of package or name');
      return pkg ? { package: pkg } : { name };
    },
  },
  {
    name: 'device_list_apps', capability: 'app.launch', wait: { initial: 30, max: 120 },
    description: 'List the apps that can be opened on the phone (package, display name, blocked), optionally filtered.',
    properties: { query: { type: 'string', description: 'Part of a name or package.' } },
    args: input => { const query = str(input.query, 'query', 200)?.trim(); return { list: true, ...(query ? { query } : {}) }; },
  },
];

const HELP_TOPICS = ['observe', 'steps', 'flow', 'errors'] as const;

export const SCREEN_HELP_TOOL = {
  name: 'device_help',
  description: 'The phone-control guide, without touching the phone: observation format, step fields and effects, a typical send-a-message flow, errors and what to do. Read it before your first device_act.',
  inputSchema: { type: 'object', properties: { topic: { type: 'string', enum: HELP_TOPICS, description: 'Omit for all.' } }, additionalProperties: false },
};

export function screenHelp(input: Record<string, unknown>): string {
  const topic = oneOf(input.topic, 'topic', HELP_TOPICS);
  return topic ? screenRules(topic) : HELP_TOPICS.map(screenRules).join('\n\n');
}

/** `CODE: message` of the step that stopped an act batch, or undefined when every step ran. */
export function stoppedLine(result: Record<string, unknown>): string | undefined {
  if (typeof result.stoppedAt !== 'number') return undefined;
  const steps = Array.isArray(result.steps) ? result.steps as Array<Record<string, unknown>> : [];
  const failed = steps[result.stoppedAt] ?? steps.findLast(item => item?.ok === false) ?? {};
  const code = typeof failed.code === 'string' && failed.code ? failed.code : 'DEVICE_FAILED';
  const message = typeof failed.message === 'string' && failed.message ? failed.message : `step ${result.stoppedAt} (${String(failed.action ?? 'unknown')}) failed; the steps after it did not run`;
  return `${code}: ${message}`;
}
