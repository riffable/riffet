import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { compareSnapshots, type ContractSnapshot } from './compat.js';
import { CONTRACTS } from './index.js';
import { SessionStateSchema } from './session.js';
import { ReasoningChannelSchema } from './sync.js';
import { ShareDraftRequestSchema } from './share.js';

/**
 * The generated fixtures of `scripts/gen-contracts.ts` are the contract between the schemas and the
 * hand-written clients. `max` and `min` must satisfy their schema; `future` adds fields a newer
 * server may send, which the schemas strip rather than reject. (`#unknown-enum` fixtures are for
 * the Kotlin decoders, whose enums are strings; the server schema stays closed.)
 */
const fixtures = (set: 'max' | 'min' | 'future') =>
  JSON.parse(readFileSync(resolve(process.cwd(), `apps/mobile/contracts/fixtures/swift/contract-fixtures.${set}.json`), 'utf8')) as Record<string, unknown>;

const contractFor = (name: string) => CONTRACTS[name.split('#')[0]!.split('~')[0]! as keyof typeof CONTRACTS];

describe('contract registry fixtures', () => {
  it.each(['max', 'min'] as const)('%s fixtures satisfy their schemas', set => {
    const all = fixtures(set);
    expect(Object.keys(all).length).toBeGreaterThan(0);
    for (const [name, payload] of Object.entries(all)) {
      const definition = contractFor(name);
      expect(definition, `${name} is not registered`).toBeDefined();
      const result = definition.schema.safeParse(payload);
      expect(result.success, `${name}: ${result.success ? '' : JSON.stringify(result.error.issues)}`).toBe(true);
    }
  });

  it('future fixtures add unknown fields without making the schema reject them', () => {
    let checked = 0;
    for (const [name, payload] of Object.entries(fixtures('future'))) {
      if (name.endsWith('#unknown-enum')) continue;
      const result = contractFor(name).schema.safeParse(payload);
      expect(result.success, `${name}: ${result.success ? '' : JSON.stringify(result.error.issues)}`).toBe(true);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('registers the Session, Run and v3 sync contracts', () => {
    for (const name of ['Session', 'SessionState', 'Run', 'RunState', 'SyncFrame', 'TimelineRow', 'TimelinePage', 'TimelineChanges', 'LaneFind'] as const) {
      expect(CONTRACTS[name]?.direction).toBe('response');
    }
  });
});

const snapshot = (contracts: ContractSnapshot['contracts']): ContractSnapshot => ({ version: '0.6.0', contracts });
const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'output', reused: 'inline' }) as Record<string, unknown>;

describe('additive compatibility', () => {
  it('matches mode-discriminated share requests and still detects a narrowed branch', () => {
    const shape = jsonSchema(ShareDraftRequestSchema);
    const before = snapshot({ ShareDraftRequest: { direction: 'request', schema: shape } });
    expect(compareSnapshots(before, snapshot({ ShareDraftRequest: { direction: 'request', schema: structuredClone(shape) } }))).toEqual([]);
    const narrowed = structuredClone(shape) as { properties: { selection: { oneOf: Array<{ properties: { count?: { maximum: number } } }> } } };
    const recent = narrowed.properties.selection.oneOf.find(branch => branch.properties.count);
    recent!.properties.count!.maximum = 10;
    expect(compareSnapshots(before, snapshot({ ShareDraftRequest: { direction: 'request', schema: narrowed } }))).toContainEqual(expect.objectContaining({ rule: 'constraint-tightened' }));
  });

  it('flags a new closed enum value as breaking', () => {
    const previous = snapshot({ SessionState: { direction: 'response', schema: jsonSchema(SessionStateSchema) } });
    const next = snapshot({
      SessionState: { direction: 'response', schema: jsonSchema(z.enum([...SessionStateSchema.options, 'paused'])) },
    });
    expect(compareSnapshots(previous, next)).toContainEqual(expect.objectContaining({
      contract: 'SessionState',
      rule: 'closed-enum-added',
    }));
  });

  it('accepts a new value on an enum the Kotlin decoder keeps as UNKNOWN', () => {
    const previous = snapshot({ ReasoningChannel: { direction: 'response', schema: jsonSchema(ReasoningChannelSchema) } });
    const next = snapshot({
      ReasoningChannel: { direction: 'response', schema: jsonSchema(z.enum([...ReasoningChannelSchema.options, 'summary'])) },
    });
    expect(compareSnapshots(previous, next)).toEqual([]);
  });

  it('accepts an additive response field and rejects a removed one', () => {
    const previous = snapshot({
      Thing: { direction: 'response', schema: jsonSchema(z.object({ id: z.string(), title: z.string() })) },
    });
    const added = snapshot({
      Thing: { direction: 'response', schema: jsonSchema(z.object({ id: z.string(), title: z.string(), extra: z.string().optional() })) },
    });
    const removed = snapshot({
      Thing: { direction: 'response', schema: jsonSchema(z.object({ id: z.string() })) },
    });
    expect(compareSnapshots(previous, added)).toEqual([]);
    expect(compareSnapshots(previous, removed)).toContainEqual(expect.objectContaining({ rule: 'field-removed' }));
  });

  it('rejects a new required request field and tightened constraints', () => {
    const previous = snapshot({
      ThingRequest: { direction: 'request', schema: jsonSchema(z.object({ id: z.string().max(20) })) },
    });
    const next = snapshot({
      ThingRequest: { direction: 'request', schema: jsonSchema(z.object({ id: z.string().max(10), owner: z.string() })) },
    });
    const breaks = compareSnapshots(previous, next);
    expect(breaks).toContainEqual(expect.objectContaining({ rule: 'new-required-field' }));
    expect(breaks).toContainEqual(expect.objectContaining({ rule: 'constraint-tightened' }));
  });

  it('rejects tightened array and object size constraints', () => {
    const previous = snapshot({
      ThingRequest: {
        direction: 'request',
        schema: {
          type: 'object',
          properties: {
            ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 },
            meta: { type: 'object', minProperties: 1, maxProperties: 5 },
          },
        },
      },
    });
    const next = snapshot({
      ThingRequest: {
        direction: 'request',
        schema: {
          type: 'object',
          properties: {
            ids: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 },
            meta: { type: 'object', minProperties: 2, maxProperties: 3 },
          },
        },
      },
    });
    const messages = compareSnapshots(previous, next).map(entry => entry.message);
    expect(messages).toEqual(expect.arrayContaining([
      'minItems 1 -> 2', 'maxItems 10 -> 4', 'minProperties 1 -> 2', 'maxProperties 5 -> 3',
    ]));
  });

  it('rejects narrowing an untyped request field to a type', () => {
    const previous = snapshot({
      ThingRequest: { direction: 'request', schema: { type: 'object', properties: { value: {} } } },
    });
    const next = snapshot({
      ThingRequest: { direction: 'request', schema: { type: 'object', properties: { value: { type: 'string' } } } },
    });
    expect(compareSnapshots(previous, next)).toContainEqual(expect.objectContaining({
      path: '$.value',
      rule: 'type-tightened',
    }));
  });

  it('accepts a response narrowing to one literal', () => {
    const previous = snapshot({
      Thing: { direction: 'response', schema: { type: 'object', properties: { protocol: { type: 'number' } } } },
    });
    const next = snapshot({
      Thing: { direction: 'response', schema: { type: 'object', properties: { protocol: { type: 'number', const: 3 } } } },
    });
    expect(compareSnapshots(previous, next)).toEqual([]);
  });
});
