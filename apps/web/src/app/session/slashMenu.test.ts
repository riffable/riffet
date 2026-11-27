import { describe, expect, it } from 'vitest';
import type { SlashCommand } from './model';
import { passthroughSlashFirst, rankSlashItems, slashMenuGroups } from './slashMenu';

const cmd = (name: string, description?: string): SlashCommand => ({ name, kind: 'command', ...(description ? { description } : {}) });
const skill = (name: string, description?: string): SlashCommand => ({ name, kind: 'skill', ...(description ? { description } : {}) });

describe('slashMenu ranking', () => {
  const catalog: SlashCommand[] = [
    cmd('new', 'Start a new topic'),
    cmd('model', 'Choose model'),
    skill('new-repo', 'Create a Cursor-hosted repo'),
    skill('accel-cli-integrate-workload-analysis', '分析综合负载'),
    skill('magpie-cli', 'Create a new JSB method'),
    skill('accel-cli-biweekly-efficiency-report', '生成双周效率指标周报'),
  ];

  it('ranks exact commands ahead of prefix skills and rejects scattered non-initial subsequences', () => {
    const groups = slashMenuGroups(catalog, 'new');
    expect(groups.map(group => ({ kind: group.kind, names: group.items.map(item => item.name) }))).toEqual([
      { kind: 'command', names: ['new'] },
      { kind: 'skill', names: ['new-repo', 'magpie-cli'] },
    ]);
    // Segment-initial abbreviations still match (`nr` -> `new-repo`).
    expect(rankSlashItems(catalog, 'nr').map(item => item.name)).toEqual(['new-repo']);
  });

  it('puts verbatim passthrough first only for valid command tokens with no name match', () => {
    const skillsOnly = catalog.filter(item => item.kind === 'skill');
    // `new` matches `new-repo` by name prefix -> keep autocomplete first.
    expect(passthroughSlashFirst(rankSlashItems(skillsOnly, 'new'), 'new')).toBe(false);
    // `jsb` only matches `magpie-cli` by description -> CLI passthrough leads.
    expect(passthroughSlashFirst(rankSlashItems(skillsOnly, 'jsb'), 'jsb')).toBe(true);
    // Non-ASCII description search keeps matching skills first.
    expect(passthroughSlashFirst(rankSlashItems(skillsOnly, '周报'), '周报')).toBe(false);
  });
});
