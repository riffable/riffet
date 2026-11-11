import { describe, expect, it } from 'vitest';
import type { NativeSlashItem } from '../../../../../packages/contracts/src/index.js';
import { leadsWithCommand, leadWithInlineSkill, parseClaudeCommands } from './slash.js';

describe('leadsWithCommand', () => {
  const items: NativeSlashItem[] = [{ name: 'dataviz', kind: 'skill' }, { name: 'compact', kind: 'command' }];

  it('treats a leading skill as a turn and any other leading slash as a command', () => {
    expect(leadsWithCommand('/dataviz chart this', items)).toBe(false);
    expect(leadsWithCommand('  /compact', items)).toBe(true);
    expect(leadsWithCommand('/summarize-unlisted', items)).toBe(true);
    expect(leadsWithCommand('please /dataviz', items)).toBe(false);
  });
});

describe('parseClaudeCommands', () => {
  it('tells file-backed and plugin entries from built-ins and strips the source marker', () => {
    expect(parseClaudeCommands([
      { name: 'compact', description: 'Free up context', argumentHint: '<instructions>' },
      { name: 'learn', description: 'Archive pipeline (user)', argumentHint: '' },
      { name: 'review-pr', description: 'Review a PR (project)' },
      { name: 'arc:dev', description: '(arc) Client development' },
      { name: '/model', description: 'Set the model' },
      { name: 'compact', description: 'duplicate' },
      { description: 'nameless' },
    ])).toEqual([
      { name: 'compact', kind: 'command', description: 'Free up context', hint: '<instructions>' },
      { name: 'learn', kind: 'skill', description: 'Archive pipeline' },
      { name: 'review-pr', kind: 'skill', description: 'Review a PR' },
      { name: 'arc:dev', kind: 'skill', description: '(arc) Client development' },
      { name: 'model', kind: 'command', description: 'Set the model' },
    ]);
  });

  it('answers nothing for a malformed listing', () => {
    expect(parseClaudeCommands(undefined)).toEqual([]);
  });
});

describe('leadWithInlineSkill', () => {
  const items: NativeSlashItem[] = [
    { name: 'dataviz', kind: 'skill' },
    { name: 'arc:dev', kind: 'skill' },
    { name: 'compact', kind: 'command' },
  ];

  it('moves a message that names one skill mid-sentence behind it, text unchanged', () => {
    expect(leadWithInlineSkill('please chart this with /dataviz now', items)).toBe('/dataviz please chart this with /dataviz now');
    expect(leadWithInlineSkill('ship it via /arc:dev', items)).toBe('/arc:dev ship it via /arc:dev');
  });

  it('leaves a message that already opens with a slash, names no skill, or names several', () => {
    expect(leadWithInlineSkill('/compact keep the plan', items)).toBe('/compact keep the plan');
    expect(leadWithInlineSkill('  /dataviz chart', items)).toBe('  /dataviz chart');
    expect(leadWithInlineSkill('please /compact now', items)).toBe('please /compact now');
    expect(leadWithInlineSkill('read /usr/bin and /unknown', items)).toBe('read /usr/bin and /unknown');
    expect(leadWithInlineSkill('use /dataviz and /arc:dev', items)).toBe('use /dataviz and /arc:dev');
  });
});
