import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuxiliaryModelRef } from '../../../../packages/contracts/src/index.js';
import type { NativeBackendProfileConfig } from '../backends/types.js';
import type { TurnSummaryRequest } from './request.js';
import { TurnSummaryService } from './service.js';

const REF: AuxiliaryModelRef = { backendId: 'dsh', profileId: 'gateway', model: 'dsh:deepseek-official:deepseek-v4.1-flash[effort=max]' };
const PROFILE: NativeBackendProfileConfig = {
  id: 'gateway', backendId: 'dsh', name: 'Gateway',
  config: { apiEndpoint: 'https://gateway.example', apiKey: 'secret', enabledModels: ['dsh:deepseek-official:deepseek-v4.1-flash'] },
};

const services: TurnSummaryService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); });

describe('TurnSummaryService', () => {
  it('writes a turn once, keeps it across a restart, writes again for a changed answer, and does nothing without a model', async () => {
    const db = new DatabaseSync(':memory:');
    let model: AuxiliaryModelRef | undefined;
    let answer = 'The login bug is fixed in abc1234.';
    const requests: TurnSummaryRequest[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const open = () => {
      const service = new TurnSummaryService({
        db, summaryModel: () => model, gatewayProfiles: backendId => backendId === 'dsh' ? [PROFILE] : [],
        source: async () => ({ question: 'fix login', answer }),
        request: async request => { requests.push(request); await gate; return `summary ${requests.length}`; },
      });
      services.push(service);
      return service;
    };

    const first = open();
    expect(await first.get('s1', 't1')).toBeUndefined();
    expect(requests).toHaveLength(0);

    model = REF;
    // Two askers share one call; the one that gives up does not cancel it.
    const left = new AbortController();
    const abandoned = first.get('s1', 't1', left.signal);
    const kept = first.get('s1', 't1');
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    left.abort();
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
    release();
    expect(await kept).toBe('summary 1');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ baseUrl: 'https://gateway.example', model: 'deepseek-v4.1-flash', question: 'fix login', answer });
    expect(await first.get('s1', 't1')).toBe('summary 1');

    // A restart reads the store; a changed answer is written again; another conversation is its own.
    const second = open();
    expect(await second.get('s1', 't1')).toBe('summary 1');
    expect(requests).toHaveLength(1);
    answer = 'The login bug is fixed in abc1234 and covered by a test.';
    expect(await second.get('s1', 't1')).toBe('summary 2');
    expect(await second.get('s2', 't1')).toBe('summary 3');
    db.close();
  });
});
