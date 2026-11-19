import { beforeEach, describe, expect, it } from 'vitest';
import { readViewPrefs, setChapterNavigation, setProcessFoldTiming, setViewOrder, viewPrefs } from './viewPrefs';

describe('session view preferences', () => {
  beforeEach(() => viewPrefs.set({ order: [], hidden: [], chapterNavigation: true, processFoldTiming: 'turn-end' }));

  it('migrates the old canvas id and keeps ids it does not know, never hiding the conversation', () => {
    const prefs = readViewPrefs(JSON.stringify({ order: ['canvas', 'chat', 'acme.board/board', 'canvas'], hidden: ['chat', 'canvas', 'acme.board/board'] }));
    expect(prefs.order).toEqual(['riffet.canvas/canvas', 'chat', 'acme.board/board']);
    expect(prefs.hidden).toEqual(['riffet.canvas/canvas', 'acme.board/board']);
  });

  it('keeps a view that is not offered in its slot when the offered ones are reordered', () => {
    viewPrefs.set({ order: ['chat', 'riffet.canvas/canvas', 'terminal'] });
    setViewOrder(['terminal', 'chat']);
    expect(viewPrefs.get().order).toEqual(['terminal', 'riffet.canvas/canvas', 'chat']);
  });

  it('defaults existing preferences to chapters enabled and preserves an explicit disabled choice', () => {
    expect(readViewPrefs('{}').chapterNavigation).toBe(true);
    setChapterNavigation(false);
    expect(readViewPrefs(JSON.stringify(viewPrefs.get())).chapterNavigation).toBe(false);
  });

  it('defaults process auto-fold to turn-end and persists next-input', () => {
    expect(readViewPrefs('{}').processFoldTiming).toBe('turn-end');
    setProcessFoldTiming('next-input');
    expect(readViewPrefs(JSON.stringify(viewPrefs.get())).processFoldTiming).toBe('next-input');
  });
});
