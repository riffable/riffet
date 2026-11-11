import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '../../../../../packages/contracts/src/index.js';
import { mergeDshModelListing } from './index.js';

const ladder = [{ id: 'effort', name: 'Reasoning effort', type: 'select' as const, currentValue: 'high', options: [{ value: 'high', name: 'high' }] }];

/** DSH spells every id it reports as a full `dsh:<provider>:<model>` selection; a gateway does not. */
const normalize = (id: string) => `dsh:deepseek-official:${id}`;
const dsh = (id: string, configOptions = ladder): ModelInfo => ({ value: normalize(id), name: id, configOptions });
const gateway = (id: string, configOptions = ladder): ModelInfo => ({ value: id, name: id, configOptions });

// Riffet declares a gateway id's input types by writing a row into DSH's own catalog. That row
// describes input types and nothing else, so a naive "DSH knows it, DSH wins" rule would silently
// drop the gateway's Effort control from the picker the moment anyone ticked 图片.
describe('mergeDshModelListing', () => {
  it('keeps the gateway ladder when the DSH row only declares input types', () => {
    const merged = mergeDshModelListing([dsh('deepseek-v4.1-flash', [])], [gateway('deepseek-v4.1-flash')], normalize);
    expect(merged).toEqual([{ value: normalize('deepseek-v4.1-flash'), name: 'deepseek-v4.1-flash', configOptions: ladder }]);
  });

  it('still lets a DSH entry that has a ladder of its own win', () => {
    const merged = mergeDshModelListing([dsh('deepseek-flash')], [gateway('deepseek-flash', [])], normalize);
    expect(merged[0]).toMatchObject({ value: normalize('deepseek-flash'), configOptions: ladder });
  });

  it('falls back to the gateway entry for an id DSH does not list at all', () => {
    const served = [gateway('glm-5.3-flash')];
    expect(mergeDshModelListing([], served, normalize)).toEqual([{ value: normalize('glm-5.3-flash'), name: 'glm-5.3-flash', configOptions: ladder }]);
  });

  // The result is the gateway's list, so its order is the order the picker shows.
  it('keeps the gateway order across both sources', () => {
    const merged = mergeDshModelListing([dsh('b'), dsh('a')], [gateway('a', []), gateway('b', [])], normalize);
    expect(merged.map(model => model.value)).toEqual([normalize('a'), normalize('b')]);
  });
});
