/*
 * Additive-compatibility check for the released contract snapshot.
 *
 * The comparison is directional. For a response (or frame), a client may receive a shape that a
 * newer server extends, but never one where a field disappeared, a required field became optional,
 * or a closed enum gained a value it cannot decode. For a request, a server may accept a superset,
 * but never a shape that newly requires a field or narrows a constraint an older client cannot meet.
 *
 * `open: true` on an enum node (written by `z.enum([...]).meta({ open: true })`) and the legacy
 * contract-level `openEnums` both mean the receiving Kotlin DTO falls back to `UNKNOWN`, so an added
 * value there is additive. `negotiated: [...]` on an enum node lists values the server only sends to a
 * client that asked for them (`ProtocolInfo.features`), so adding one of those is additive as well.
 * `negotiatedPattern` on the same node says strings beyond the enum may also arrive (a plugin's Agent id)
 * for a client that advertises the named feature; the node stays an enum, so it compares as before.
 */

export type JsonSchema = Record<string, unknown>;
export type ContractDirection = 'request' | 'response';

export interface SnapshotContract {
  direction: ContractDirection;
  openEnums?: boolean;
  schema: JsonSchema;
}

/** The part of `packages/contracts/schema/released/<version>.json` this check reads. */
export interface ContractSnapshot {
  version: string;
  contracts: Record<string, SnapshotContract>;
}

export interface CompatibilityBreak {
  contract: string;
  path: string;
  rule: string;
  message: string;
}

const object = (value: unknown): value is JsonSchema => !!value && typeof value === 'object' && !Array.isArray(value);
const array = (value: unknown): value is unknown[] => Array.isArray(value);

function unionBranches(schema: JsonSchema): JsonSchema[] | undefined {
  const branches = schema.anyOf ?? schema.oneOf;
  return Array.isArray(branches) ? branches as JsonSchema[] : undefined;
}

/** How a union branch is identified across releases: a discriminant literal, then its type/pattern. */
function branchSignature(branch: JsonSchema): string {
  if ('const' in branch) return `const:${JSON.stringify(branch.const)}`;
  const properties = object(branch.properties) ? branch.properties as Record<string, JsonSchema> : {};
  for (const key of ['type', 'kind', 'mode', 'ok']) {
    const property = properties[key];
    if (property && 'const' in property) return `${key}:${JSON.stringify(property.const)}`;
  }
  if (Array.isArray(branch.enum)) return `enum:${JSON.stringify(branch.enum[0])}`;
  if (Array.isArray(branch.type)) return `type:${JSON.stringify(branch.type)}`;
  if (typeof branch.type === 'string') return `type:${branch.type}${typeof branch.pattern === 'string' ? `:${branch.pattern}` : ''}`;
  return '';
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function numberConstraint(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * The inclusive lower bound. For an integer schema `exclusiveMinimum: n` accepts exactly what
 * `minimum: n + 1` accepts, so the two encodings compare as the same constraint instead of reading
 * as a tightening. Non-integer exclusivity is compared separately below.
 */
function inclusiveMinimum(schema: JsonSchema): number | undefined {
  const minimum = numberConstraint(schema.minimum);
  const exclusive = numberConstraint(schema.exclusiveMinimum);
  if (exclusive === undefined || schema.type !== 'integer') return minimum;
  const included = exclusive + 1;
  return minimum === undefined ? included : Math.max(minimum, included);
}

/** The inclusive upper bound, folding `exclusiveMaximum` the same way as {@link inclusiveMinimum}. */
function inclusiveMaximum(schema: JsonSchema): number | undefined {
  const maximum = numberConstraint(schema.maximum);
  const exclusive = numberConstraint(schema.exclusiveMaximum);
  if (exclusive === undefined || schema.type !== 'integer') return maximum;
  const included = exclusive - 1;
  return maximum === undefined ? included : Math.min(maximum, included);
}

function compareRequestConstraints(previous: JsonSchema, next: JsonSchema, report: (rule: string, message: string) => void): void {
  const previousMinLength = numberConstraint(previous.minLength);
  const nextMinLength = numberConstraint(next.minLength);
  if (nextMinLength !== undefined && nextMinLength > (previousMinLength ?? 0)) {
    report('constraint-tightened', `minLength ${previousMinLength ?? 0} -> ${nextMinLength}`);
  }
  const previousMaxLength = numberConstraint(previous.maxLength);
  const nextMaxLength = numberConstraint(next.maxLength);
  if (nextMaxLength !== undefined && nextMaxLength < (previousMaxLength ?? Number.POSITIVE_INFINITY)) {
    report('constraint-tightened', `maxLength ${previousMaxLength ?? 'unbounded'} -> ${nextMaxLength}`);
  }
  if (typeof next.pattern === 'string' && next.pattern !== previous.pattern) {
    report('constraint-tightened', `pattern added or changed: ${next.pattern}`);
  }
  if (typeof next.format === 'string' && next.format !== previous.format) {
    report('constraint-tightened', `format added or changed: ${next.format}`);
  }
  const previousMinimum = inclusiveMinimum(previous);
  const nextMinimum = inclusiveMinimum(next);
  if (nextMinimum !== undefined && nextMinimum > (previousMinimum ?? Number.NEGATIVE_INFINITY)) {
    report('constraint-tightened', `minimum ${previousMinimum ?? 'unbounded'} -> ${nextMinimum}`);
  }
  const previousMaximum = inclusiveMaximum(previous);
  const nextMaximum = inclusiveMaximum(next);
  if (nextMaximum !== undefined && nextMaximum < (previousMaximum ?? Number.POSITIVE_INFINITY)) {
    report('constraint-tightened', `maximum ${previousMaximum ?? 'unbounded'} -> ${nextMaximum}`);
  }
  // An integer schema's exclusive bounds are folded into the inclusive bounds above.
  if (!(previous.type === 'integer' && next.type === 'integer')) {
    const previousExclusiveMinimum = numberConstraint(previous.exclusiveMinimum);
    const nextExclusiveMinimum = numberConstraint(next.exclusiveMinimum);
    if (nextExclusiveMinimum !== undefined && nextExclusiveMinimum > (previousExclusiveMinimum ?? Number.NEGATIVE_INFINITY)) {
      report('constraint-tightened', `exclusiveMinimum ${previousExclusiveMinimum ?? 'unbounded'} -> ${nextExclusiveMinimum}`);
    }
    const previousExclusiveMaximum = numberConstraint(previous.exclusiveMaximum);
    const nextExclusiveMaximum = numberConstraint(next.exclusiveMaximum);
    if (nextExclusiveMaximum !== undefined && nextExclusiveMaximum < (previousExclusiveMaximum ?? Number.POSITIVE_INFINITY)) {
      report('constraint-tightened', `exclusiveMaximum ${previousExclusiveMaximum ?? 'unbounded'} -> ${nextExclusiveMaximum}`);
    }
  }
  const previousMinItems = numberConstraint(previous.minItems);
  const nextMinItems = numberConstraint(next.minItems);
  if (nextMinItems !== undefined && nextMinItems > (previousMinItems ?? 0)) {
    report('constraint-tightened', `minItems ${previousMinItems ?? 0} -> ${nextMinItems}`);
  }
  const previousMaxItems = numberConstraint(previous.maxItems);
  const nextMaxItems = numberConstraint(next.maxItems);
  if (nextMaxItems !== undefined && nextMaxItems < (previousMaxItems ?? Number.POSITIVE_INFINITY)) {
    report('constraint-tightened', `maxItems ${previousMaxItems ?? 'unbounded'} -> ${nextMaxItems}`);
  }
  const previousMinProperties = numberConstraint(previous.minProperties);
  const nextMinProperties = numberConstraint(next.minProperties);
  if (nextMinProperties !== undefined && nextMinProperties > (previousMinProperties ?? 0)) {
    report('constraint-tightened', `minProperties ${previousMinProperties ?? 0} -> ${nextMinProperties}`);
  }
  const previousMaxProperties = numberConstraint(previous.maxProperties);
  const nextMaxProperties = numberConstraint(next.maxProperties);
  if (nextMaxProperties !== undefined && nextMaxProperties < (previousMaxProperties ?? Number.POSITIVE_INFINITY)) {
    report('constraint-tightened', `maxProperties ${previousMaxProperties ?? 'unbounded'} -> ${nextMaxProperties}`);
  }
  if (next.uniqueItems === true && previous.uniqueItems !== true) report('constraint-tightened', 'uniqueItems added');
}

function compareSchema(
  previous: JsonSchema,
  next: JsonSchema,
  path: string,
  direction: ContractDirection,
  contract: SnapshotContract,
  report: (path: string, rule: string, message: string) => void,
): void {
  const previousBranches = unionBranches(previous);
  const nextBranches = unionBranches(next);
  if (previousBranches || nextBranches) {
    if (!previousBranches || !nextBranches) {
      report(path, 'union-shape-changed', 'a union became a single shape or the reverse');
      return;
    }
    for (const branch of previousBranches) {
      const signature = branchSignature(branch);
      let match = nextBranches.findIndex(candidate => branchSignature(candidate) === signature);
      if (match === -1 && !signature && previousBranches.length === nextBranches.length) {
        match = previousBranches.indexOf(branch);
      }
      if (match === -1) {
        // A nullable field that is never null any more is only a narrowing; clients already handle it.
        if (branch.type !== 'null') report(path, 'union-branch-removed', `branch ${signature || 'without discriminant'} is gone`);
        continue;
      }
      compareSchema(branch, nextBranches[match]!, `${path}[${signature || match}]`, direction, contract, report);
    }
    // A response field that may now be null cannot be read by a client that expects an object.
    if (direction === 'response' && nextBranches.some(branch => branch.type === 'null') && !previousBranches.some(branch => branch.type === 'null')) {
      report(path, 'union-null-added', 'a response shape may now be null');
    }
    return;
  }

  if (Array.isArray(previous.enum) || Array.isArray(next.enum)) {
    if (!Array.isArray(previous.enum) || !Array.isArray(next.enum)) {
      report(path, 'enum-shape-changed', 'an enum became a non-enum or the reverse');
      return;
    }
    const previousValues = previous.enum as unknown[];
    const nextValues = next.enum as unknown[];
    const open = next.open === true || previous.open === true || contract.openEnums === true;
    const negotiated = Array.isArray(next.negotiated) ? next.negotiated as unknown[] : [];
    if (direction === 'response') {
      const added = nextValues.filter(value => !previousValues.some(old => same(old, value)) && !negotiated.some(item => same(item, value)));
      if (!open && added.length) report(path, 'closed-enum-added', `added ${added.map(value => JSON.stringify(value)).join(', ')}`);
    } else {
      const removed = previousValues.filter(value => !nextValues.some(current => same(current, value)));
      if (removed.length) report(path, 'request-enum-narrowed', `removed ${removed.map(value => JSON.stringify(value)).join(', ')}`);
    }
    return;
  }

  if ('const' in previous || 'const' in next) {
    if ('const' in previous && 'const' in next) {
      if (!same(previous.const, next.const)) report(path, 'const-changed', 'a literal changed');
    } else if ('const' in next) {
      // A response may narrow to one literal safely; a request that starts rejecting every other
      // value cannot be met by an older client.
      if (direction === 'request') report(path, 'const-added', 'a request now accepts only one literal');
    } else if (direction === 'response') {
      // A request may widen from a literal safely; a response may now send a value the client
      // expecting that literal cannot read.
      report(path, 'const-removed', 'a response may now send another value');
    }
    return;
  }

  const previousType = Array.isArray(previous.type) ? JSON.stringify(previous.type) : previous.type;
  const nextType = Array.isArray(next.type) ? JSON.stringify(next.type) : next.type;
  if (previousType !== undefined && nextType !== undefined && previousType !== nextType) {
    report(path, 'type-changed', `${String(previousType)} -> ${String(nextType)}`);
    return;
  }
  if (direction === 'request' && previousType === undefined && nextType !== undefined) {
    report(path, 'type-tightened', `untyped -> ${String(nextType)}`);
  }

  if (previousType === 'object' || previous.properties) {
    const previousProperties = object(previous.properties) ? previous.properties as Record<string, JsonSchema> : {};
    const nextProperties = object(next.properties) ? next.properties as Record<string, JsonSchema> : {};
    const previousRequired = new Set(Array.isArray(previous.required) ? previous.required as string[] : []);
    const nextRequired = new Set(Array.isArray(next.required) ? next.required as string[] : []);
    for (const [key, property] of Object.entries(previousProperties)) {
      const nextProperty = nextProperties[key];
      if (!nextProperty) {
        if (direction === 'response') report(`${path}.${key}`, 'field-removed', 'a response field was removed');
        continue;
      }
      if (direction === 'response' && previousRequired.has(key) && !nextRequired.has(key)) {
        report(`${path}.${key}`, 'required-became-optional', 'a response field is no longer guaranteed');
      }
      if (direction === 'request' && !previousRequired.has(key) && nextRequired.has(key)) {
        report(`${path}.${key}`, 'new-required-field', 'a request field became required');
      }
      compareSchema(property, nextProperty, `${path}.${key}`, direction, contract, report);
    }
    for (const key of Object.keys(nextProperties)) {
      if (key in previousProperties) continue;
      if (direction === 'request' && nextRequired.has(key)) {
        report(`${path}.${key}`, 'new-required-field', 'a new request field is required');
      }
    }
    if (direction === 'request') compareRequestConstraints(previous, next, (rule, message) => report(path, rule, message));
    return;
  }

  if (previousType === 'array' || previous.items) {
    if (object(previous.items) && object(next.items)) {
      compareSchema(previous.items, next.items, `${path}[]`, direction, contract, report);
    } else if (previous.items && !next.items) {
      report(path, 'array-items-removed', 'array item schema was removed');
    }
    if (direction === 'request') compareRequestConstraints(previous, next, (rule, message) => report(path, rule, message));
    return;
  }

  if (direction === 'request') compareRequestConstraints(previous, next, (rule, message) => report(path, rule, message));
}

/** Every breaking change from `previous` to `next`; an empty list means the change is additive. */
export function compareSnapshots(previous: ContractSnapshot, next: ContractSnapshot): CompatibilityBreak[] {
  const breaks: CompatibilityBreak[] = [];
  const report = (contract: string) => (path: string, rule: string, message: string) => {
    breaks.push({ contract, path, rule, message });
  };

  for (const [name, previousContract] of Object.entries(previous.contracts)) {
    const nextContract = next.contracts[name];
    if (!nextContract) {
      report(name)('$', 'contract-removed', 'the contract is no longer registered');
      continue;
    }
    if (previousContract.direction !== nextContract.direction) {
      report(name)('$', 'direction-changed', `${previousContract.direction} -> ${nextContract.direction}`);
    }
    compareSchema(previousContract.schema, nextContract.schema, '$', nextContract.direction, nextContract, report(name));
  }

  return breaks;
}
