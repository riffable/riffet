import { describe,expect,it } from 'vitest';
import { defaultStatsUi,resolveWindow,statsFilterParams } from './stats-query';

const now = new Date(2026, 9, 8, 15, 30, 0);

describe('stats query', () => {

  it('cuts calendar windows in local time, with an exclusive end', () => {
    const today = resolveWindow({ ...defaultStatsUi(), preset: 'today' }, now);
    expect(new Date(today.from).getDate()).toBe(8);
    expect(new Date(today.from).getHours()).toBe(0);
    expect(new Date(today.to).getDate()).toBe(9);
    expect(new Date(today.to).getHours()).toBe(0);
    const week = resolveWindow({ ...defaultStatsUi(), preset: '7d' }, now);
    expect(new Date(week.from).getDate()).toBe(2);
    const custom = resolveWindow({ ...defaultStatsUi(), preset: 'custom', from: '2026-10-01', to: '2026-10-08' }, now);
    expect(new Date(custom.from).getDate()).toBe(1);
    expect(new Date(custom.to).getDate()).toBe(9);
  });

  it('sends an explicit start for all-time, because a missing from means 30 days', () => {
    const all = resolveWindow({ ...defaultStatsUi(), preset: 'all' }, now);
    expect(new Date(all.from).getFullYear()).toBe(2018);
    const params = statsFilterParams({ ...defaultStatsUi(), backends: ['claude'], includeEstimated: false }, now, 'Asia/Shanghai');
    expect(params.get('tz')).toBe('Asia/Shanghai');
    expect(params.getAll('backend')).toEqual(['claude']);
    expect(params.get('includeEstimated')).toBe('false');
    expect(params.get('from')).toBeTruthy();
  });
});
