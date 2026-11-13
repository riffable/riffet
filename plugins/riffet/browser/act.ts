// `browser_act`: steps by ref, each checked for risk before it runs (docs/BROWSER.md §4, §6). The user may use the page
// at the same time; a step that would send, submit, delete or order waits for the user's answer.

import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Locator, Page } from 'playwright-core';
import type { AgentToolContext, PluginHost } from '@riffet/plugin-api';
import type { Browsers, SessionBrowser } from './browsers.js';
import type { BrowserRiskCategory } from './protocol.js';
import { hostMatches, isLocalHost, ofClick, ofEnter, sitePatterns, type TargetInfo } from './risk.js';

export const ACTIONS = ['click', 'fill', 'type', 'press', 'select', 'check', 'hover', 'scroll', 'drag', 'upload', 'wait', 'back', 'forward', 'reload'] as const;
export type StepAction = typeof ACTIONS[number];
export interface Step {
  action: StepAction; ref?: string; to?: string; text?: string; key?: string; values?: string[]; checked?: boolean;
  button?: 'left' | 'middle' | 'right'; clickCount?: number; deltaY?: number; paths?: string[]; url?: string; ms?: number;
}

export const MAX_STEPS = 30;
const STEP_TIMEOUT = 10_000;
const CONFIRM_MS = 120_000;
const REF = /^(?:f\d+)?e\d+$/;

/** Strict parsing: unknown keys and wrong types are refused, so a typo is not silently ignored. */
export function parseSteps(value: unknown, error: PluginHost['error']): Step[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_STEPS) throw error('INVALID_ARGUMENT', `steps must list 1 to ${MAX_STEPS} steps`);
  return value.map((raw, index) => {
    const fail = (message: string) => error('INVALID_ARGUMENT', `steps[${index}]: ${message}`);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('must be an object');
    const step = raw as Record<string, unknown>;
    if (!ACTIONS.includes(step.action as StepAction)) throw fail(`action must be one of ${ACTIONS.join(', ')}`);
    const allowed = new Set(['action', ...({ click: ['ref', 'button', 'clickCount'], fill: ['ref', 'text'], type: ['ref', 'text'], press: ['key', 'ref'], select: ['ref', 'values'], check: ['ref', 'checked'], hover: ['ref'], scroll: ['ref', 'deltaY'], drag: ['ref', 'to'], upload: ['ref', 'paths'], wait: ['text', 'url', 'ms'], back: [], forward: [], reload: [] } as Record<StepAction, string[]>)[step.action as StepAction]]);
    const extra = Object.keys(step).find(key => !allowed.has(key));
    if (extra) throw fail(`${String(step.action)} does not take ${extra}`);
    const needsRef = ['click', 'fill', 'type', 'select', 'check', 'hover', 'drag', 'upload'].includes(step.action as string);
    for (const key of ['ref', 'to'] as const) if (step[key] !== undefined && (typeof step[key] !== 'string' || !REF.test(step[key] as string))) throw fail(`${key} must be a ref like e12 from the latest snapshot`);
    if (needsRef && step.ref === undefined) throw fail(`${String(step.action)} needs ref`);
    if (step.action === 'drag' && step.to === undefined) throw fail('drag needs to');
    for (const key of ['text', 'key', 'url'] as const) if (step[key] !== undefined && (typeof step[key] !== 'string' || (step[key] as string).length > 100_000)) throw fail(`${key} must be text`);
    if ((step.action === 'fill' || step.action === 'type') && typeof step.text !== 'string') throw fail(`${String(step.action)} needs text`);
    if (step.action === 'press' && typeof step.key !== 'string') throw fail('press needs key, e.g. Enter or Control+A');
    if (step.values !== undefined && (!Array.isArray(step.values) || step.values.some(item => typeof item !== 'string'))) throw fail('values must be a list of option values or labels');
    if (step.action === 'select' && !Array.isArray(step.values)) throw fail('select needs values');
    if (step.paths !== undefined && (!Array.isArray(step.paths) || step.paths.some(item => typeof item !== 'string') || step.paths.length > 20)) throw fail('paths must list at most 20 file paths');
    if (step.action === 'upload' && !Array.isArray(step.paths)) throw fail('upload needs paths');
    if (step.checked !== undefined && typeof step.checked !== 'boolean') throw fail('checked must be true or false');
    if (step.button !== undefined && !['left', 'middle', 'right'].includes(step.button as string)) throw fail('button must be left, middle or right');
    for (const [key, min, max] of [['clickCount', 1, 3], ['deltaY', -20_000, 20_000], ['ms', 0, 10_000]] as const) {
      if (step[key] !== undefined && (typeof step[key] !== 'number' || !Number.isFinite(step[key]) || (step[key] as number) < min || (step[key] as number) > max)) throw fail(`${key} must be a number from ${min} to ${max}`);
    }
    if (step.action === 'wait' && step.text === undefined && step.url === undefined && step.ms === undefined) throw fail('wait needs text, url or ms');
    return step as unknown as Step;
  });
}

export interface StepResult { index: number; action: StepAction; ok: boolean; code?: string; message?: string; authorizedBy?: 'site' | 'user' }

/** What the element a click or Enter lands on says about itself, read in the page. */
async function targetInfo(locator: Locator): Promise<TargetInfo | undefined> {
  const read = (element: Element | null) => {
    if (!element) return undefined;
    const target = (element.closest('button,a,[role=button],[role=link],[role=menuitem],input[type=submit],input[type=button]') ?? element) as HTMLElement & { value?: string; type?: string; form?: unknown };
    const names = [target.getAttribute('aria-label'), (target.innerText ?? '').slice(0, 200), ['submit', 'button'].includes(String(target.type)) ? target.value : undefined, target.getAttribute('title')].filter((item): item is string => Boolean(item && item.trim()));
    const idText = [target.id, target.getAttribute('name'), target.getAttribute('data-testid'), typeof target.className === 'string' ? target.className : ''].join(' ');
    const submits = (target.tagName === 'BUTTON' && target.type === 'submit' && Boolean(target.form)) || (target.tagName === 'INPUT' && target.type === 'submit');
    const fieldHints = [target.tagName.toLowerCase(), target.getAttribute('type'), target.getAttribute('placeholder'), target.getAttribute('name'), target.getAttribute('role'), target.getAttribute('aria-label')].filter(Boolean).join(' ');
    return { names, idText, submits, fieldHints };
  };
  try {
    const raw = await locator.evaluate(read, undefined, { timeout: 2000 });
    if (!raw) return undefined;
    const idWords = raw.idText.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return { names: raw.names, idWords, submits: raw.submits, fieldHints: raw.fieldHints };
  } catch { return undefined; }
}

/** The focused element of the page, for a press without a ref. */
async function focused(page: Page): Promise<TargetInfo | undefined> {
  try {
    const raw = await page.evaluate(() => {
      const target = document.activeElement as HTMLElement | null;
      if (!target || target === document.body) return undefined;
      return { names: [target.getAttribute('aria-label') ?? ''].filter(Boolean), idText: [target.id, target.getAttribute('name')].join(' '), fieldHints: [target.tagName.toLowerCase(), target.getAttribute('type'), target.getAttribute('placeholder'), target.getAttribute('role'), target.getAttribute('name')].filter(Boolean).join(' ') };
    });
    if (!raw) return undefined;
    return { names: raw.names, idWords: raw.idText.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean), submits: false, fieldHints: raw.fieldHints };
  } catch { return undefined; }
}

/** A file path inside the project, or a refusal. */
async function projectFile(path: string, projectPath: string | undefined, error: PluginHost['error']): Promise<string> {
  if (!projectPath) throw error('BROWSER_FAILED', 'This conversation has no project directory to upload from', 400);
  const root = await realpath(projectPath);
  const full = await realpath(isAbsolute(path) ? path : resolve(root, path)).catch(() => { throw error('INVALID_ARGUMENT', `${path} does not exist`); });
  const inside = relative(root, full);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw error('INVALID_ARGUMENT', `${path} is outside the project directory`);
  return full;
}

export class StepRunner {
  constructor(private readonly browsers: Browsers, private readonly host: PluginHost) {}

  private settings() { return this.host.settings(); }

  /** Whether a step of this category may run here without asking; `pay` is never the agent's to do. */
  private async authorize(session: SessionBrowser, page: Page, category: BrowserRiskCategory, target: TargetInfo | undefined, context: AgentToolContext): Promise<'site' | 'user' | undefined> {
    let host = '';
    try { host = new URL(page.url()).hostname; } catch { /* about:blank */ }
    const label = (target?.names[0] ?? '').trim().slice(0, 200);
    if (category === 'pay') {
      throw this.host.error('BROWSER_HANDOFF_REQUIRED', `This step looks like a payment ("${label}"). Payments are completed by the user: call browser_handoff with the reason.`, 409);
    }
    if (category !== 'order' && (isLocalHost(host) || hostMatches(host, sitePatterns(this.settings().allowSites)))) return 'site';
    const answer = await this.browsers.waitForUser(session,
      { id: randomUUID(), kind: 'confirm', category, target: label || category, url: page.url(), expiresAt: new Date(Date.now() + CONFIRM_MS).toISOString() },
      { title: 'Browser', body: `The agent wants to ${category} on ${host || page.url()}: "${label || category}". Open the conversation's browser panel to allow or deny.` },
      CONFIRM_MS, context.signal);
    if (answer.ok) return 'user';
    if (answer.timedOut) throw this.host.error('BROWSER_CONFIRM_TIMEOUT', `Nobody answered the confirmation for "${label || category}" within ${CONFIRM_MS / 1000} s`, 408);
    throw this.host.error('BROWSER_DENIED', `The user declined: ${category} "${label || category}"`, 403);
  }

  private locate(page: Page, ref: string): Locator { return page.getByRef(ref); }

  private async resolved(page: Page, ref: string): Promise<Locator> {
    const locator = this.locate(page, ref);
    const count = await locator.count().catch(() => 0);
    if (!count) throw this.host.error('BROWSER_STALE_REF', `No element ${ref} in the latest snapshot; take a new browser_snapshot`, 409);
    return locator.first();
  }

  async run(session: SessionBrowser, page: Page, steps: Step[], context: AgentToolContext): Promise<{ results: StepResult[]; stoppedAt?: number }> {
    const results: StepResult[] = [];
    for (const [index, step] of steps.entries()) {
      if (context.signal.aborted) return { results, stoppedAt: index };
      try {
        const authorizedBy = await this.step(session, page, step, context);
        results.push({ index, action: step.action, ok: true, ...(authorizedBy ? { authorizedBy } : {}) });
      } catch (error) {
        const code = (error as { code?: string }).code;
        const message = error instanceof Error ? error.message.split('\n')[0]!.slice(0, 600) : String(error);
        results.push({ index, action: step.action, ok: false, code: code ?? (/timeout/i.test(message) ? 'BROWSER_TIMEOUT' : 'BROWSER_FAILED'), message });
        return { results, stoppedAt: index };
      }
    }
    return { results };
  }

  private async step(session: SessionBrowser, page: Page, step: Step, context: AgentToolContext): Promise<'site' | 'user' | undefined> {
    const timeout = STEP_TIMEOUT;
    switch (step.action) {
      case 'click': {
        const locator = await this.resolved(page, step.ref!);
        const info = await targetInfo(locator);
        const category = ofClick(info ?? { names: [], idWords: [], submits: false });
        const authorizedBy = category ? await this.authorize(session, page, category, info, context) : undefined;
        // The page may have changed while the user decided: the ref is resolved again.
        const target = authorizedBy === 'user' ? await this.resolved(page, step.ref!) : locator;
        await target.click({ timeout, ...(step.button ? { button: step.button } : {}), ...(step.clickCount ? { clickCount: step.clickCount } : {}) });
        return authorizedBy;
      }
      case 'press': {
        const locator = step.ref ? await this.resolved(page, step.ref) : undefined;
        const isEnter = /(^|\+)Enter$/.test(step.key!) && !/Shift\+Enter$/.test(step.key!);
        let authorizedBy: 'site' | 'user' | undefined;
        if (isEnter) {
          const target = locator ? await targetInfo(locator) : await focused(page);
          const category = ofEnter(target);
          if (category) authorizedBy = await this.authorize(session, page, category, target, context);
        }
        if (locator) await locator.press(step.key!, { timeout }); else await page.keyboard.press(step.key!);
        return authorizedBy;
      }
      case 'fill': await (await this.resolved(page, step.ref!)).fill(step.text!, { timeout }); return undefined;
      case 'type': await (await this.resolved(page, step.ref!)).pressSequentially(step.text!, { timeout }); return undefined;
      case 'select': await (await this.resolved(page, step.ref!)).selectOption(step.values!, { timeout }); return undefined;
      case 'check': await (await this.resolved(page, step.ref!)).setChecked(step.checked ?? true, { timeout }); return undefined;
      case 'hover': await (await this.resolved(page, step.ref!)).hover({ timeout }); return undefined;
      case 'scroll': {
        if (step.ref) {
          const locator = await this.resolved(page, step.ref);
          await locator.scrollIntoViewIfNeeded({ timeout });
          if (step.deltaY) { await locator.hover({ timeout }); await page.mouse.wheel(0, step.deltaY); }
        } else await page.mouse.wheel(0, step.deltaY ?? 600);
        return undefined;
      }
      case 'drag': await (await this.resolved(page, step.ref!)).dragTo(await this.resolved(page, step.to!), { timeout }); return undefined;
      case 'upload': {
        const files = await Promise.all(step.paths!.map(path => projectFile(path, context.projectPath, this.host.error)));
        await (await this.resolved(page, step.ref!)).setInputFiles(files, { timeout });
        return undefined;
      }
      case 'wait':
        if (step.text !== undefined) await page.getByText(step.text).first().waitFor({ state: 'visible', timeout });
        if (step.url !== undefined) await page.waitForURL(url => url.href.includes(step.url!), { timeout });
        if (step.ms !== undefined) await page.waitForTimeout(step.ms);
        return undefined;
      case 'back': await page.goBack({ timeout, waitUntil: 'domcontentloaded' }); return undefined;
      case 'forward': await page.goForward({ timeout, waitUntil: 'domcontentloaded' }); return undefined;
      case 'reload': await page.reload({ timeout, waitUntil: 'domcontentloaded' }); return undefined;
    }
  }
}
