import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AGY_ID, AGY_STEP_LIMIT, type AgyRecord, type AgySnapshot } from './protocol.js';

// Field numbers are taken from agy 1.5.6 and 1.5.10's embedded protobuf descriptors. Only
// transcript data is decoded: configs, credentials and model signatures never leave the store.
type Wire = bigint | Uint8Array;
type Fields = Map<number, Wire[]>;
const MAX_BYTES = 64 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
function refuse(detail: string): never {
  throw new Error(`Unsupported Antigravity transcript: ${detail}`);
}
function varint(bytes: Uint8Array, state: { at: number }): bigint {
  let value = 0n;
  for (let shift = 0; shift < 70; shift += 7) {
    const byte = bytes[state.at++];
    if (byte === undefined || (shift === 63 && byte > 1)) refuse('invalid protobuf varint');
    value |= BigInt(byte & 127) << BigInt(shift);
    if (!(byte & 128)) return value;
  }
  return refuse('invalid protobuf varint');
}
function fields(bytes: Uint8Array): Fields {
  if (bytes.byteLength > MAX_BYTES) refuse('protobuf record exceeds limit');
  const out: Fields = new Map(),
    state = { at: 0 };
  while (state.at < bytes.length) {
    const tag = varint(bytes, state),
      n = Number(tag >> 3n),
      wire = Number(tag & 7n);
    if (!n || n > 536870911) refuse('invalid protobuf field');
    let value: Wire;
    if (wire === 0) value = varint(bytes, state);
    else if (wire === 1 || wire === 5 || wire === 2) {
      const length = wire === 2 ? Number(varint(bytes, state)) : wire === 1 ? 8 : 4;
      if (!Number.isSafeInteger(length) || length > bytes.length - state.at) refuse('truncated protobuf field');
      value = bytes.subarray(state.at, state.at + length);
      state.at += length;
    } else refuse('invalid protobuf wire type');
    const values = out.get(n) ?? [];
    values.push(value);
    out.set(n, values);
    if (values.length > AGY_STEP_LIMIT || out.size > 4096) refuse('protobuf field limit exceeded');
  }
  return out;
}
function one(f: Fields, n: number): Wire | undefined {
  const values = f.get(n);
  if (values && values.length !== 1) refuse('duplicate scalar protobuf field');
  return values?.[0];
}
function blob(f: Fields, n: number): Uint8Array | undefined {
  const value = one(f, n);
  if (value !== undefined && !(value instanceof Uint8Array)) refuse('invalid protobuf bytes');
  return value;
}
function str(f: Fields, n: number): string | undefined {
  const value = blob(f, n);
  if (!value) return undefined;
  try {
    return utf8.decode(value);
  } catch {
    return refuse('invalid protobuf UTF-8');
  }
}
function uint(f: Fields, n: number): number | string | undefined {
  const value = one(f, n);
  if (value === undefined) return undefined;
  if (typeof value !== 'bigint') refuse('invalid protobuf integer');
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}
function num(f: Fields, n: number, fallback = 0): number {
  const value = uint(f, n);
  if (typeof value === 'string') refuse('protobuf integer exceeds safe range');
  return value ?? fallback;
}
function optionalBool(f: Fields, n: number): boolean | undefined {
  return f.has(n) ? num(f, n) !== 0 : undefined;
}
function sub(f: Fields, n: number): Fields {
  const b = blob(f, n);
  return b ? fields(b) : new Map();
}
function repeated(f: Fields, n: number): Fields[] {
  return (f.get(n) ?? []).map(value => {
    if (!(value instanceof Uint8Array)) refuse('invalid repeated protobuf message');
    return fields(value);
  });
}
function strings(f: Fields, n: number): string[] {
  return (f.get(n) ?? []).map(value => {
    if (!(value instanceof Uint8Array)) refuse('invalid repeated protobuf string');
    try {
      return utf8.decode(value);
    } catch {
      return refuse('invalid protobuf UTF-8');
    }
  });
}
function timestamp(f: Fields): string | undefined {
  if (!f.size) return undefined;
  const seconds = num(f, 1),
    nanos = num(f, 2);
  if (nanos < 0 || nanos >= 1e9 || seconds > 253402300799) refuse('invalid protobuf timestamp');
  const date = new Date(seconds * 1000 + Math.floor(nanos / 1e6));
  if (!Number.isFinite(date.getTime())) refuse('invalid protobuf timestamp');
  // Native timestamps have microsecond precision; keep it for stable live/store event fingerprints.
  return date.toISOString().replace(/\.\d{3}Z$/, nanos ? `.${String(nanos).padStart(9, '0').replace(/0+$/, '')}Z` : 'Z');
}
function compact(value: AgyRecord): AgyRecord {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}
const statusNames: Record<number, string> = {
  0: 'UNSPECIFIED',
  1: 'PENDING',
  2: 'RUNNING',
  3: 'DONE',
  4: 'INVALID',
  5: 'CLEARED',
  6: 'CANCELED',
  7: 'ERROR',
  8: 'GENERATING',
  9: 'WAITING',
  11: 'QUEUED',
  12: 'INTERRUPTED',
};
const sourceNames: Record<number, string> = {
  0: 'UNSPECIFIED',
  2: 'MODEL',
  3: 'USER_IMPLICIT',
  4: 'USER_EXPLICIT',
  5: 'SYSTEM',
  6: 'SYSTEM_SDK',
};
const reasons: Record<number, string> = {
  0: 'UNSPECIFIED',
  1: 'ERROR',
  2: 'USER_CANCELED',
  3: 'MAX_INVOCATIONS',
  4: 'NO_TOOL_CALL',
  6: 'MAX_FORCED_INVOCATIONS',
  7: 'EARLY_CONTINUE',
  8: 'TERMINAL_STEP_TYPE',
  9: 'TERMINAL_CUSTOM_HOOK',
  10: 'INJECTED_RESPONSE',
  11: 'MAX_TOKEN_BUDGET_EXCEEDED',
  12: 'CHAINED',
};
function tool(f: Fields): AgyRecord {
  return compact({ id: str(f, 1), name: str(f, 2), argumentsJson: str(f, 3) });
}
function error(f: Fields): AgyRecord {
  return compact({ userErrorMessage: str(f, 1), shortError: str(f, 2), fullError: str(f, 3), modelErrorMessage: str(f, 9) });
}
function renderInfo(f: Fields): AgyRecord {
  return compact({
    title: str(f, 1),
    markdown: str(f, 2),
    hidden: optionalBool(f, 4),
    contentBlocks: repeated(f, 10).flatMap(block => {
      const markdown = str(block, 1);
      return markdown ? [{ markdown }] : [];
    }),
  });
}
function image(f: Fields): AgyRecord {
  return compact({ base64Data: str(f, 1), mimeType: str(f, 2), caption: str(f, 3), uri: str(f, 4) });
}
function media(f: Fields): AgyRecord {
  return compact({ mimeType: str(f, 1), data: blob(f, 2) ? Buffer.from(blob(f, 2)!).toString('base64') : undefined });
}
function metadata(f: Fields): AgyRecord {
  const source = sub(f, 20),
    usage = sub(f, 9),
    info = sub(f, 24);
  return compact({
    createdAt: timestamp(sub(f, 1)),
    startedAt: timestamp(sub(f, 32)),
    completedAt: timestamp(sub(f, 8)),
    finishedGeneratingAt: timestamp(sub(f, 7)),
    source: sourceNames[num(f, 3)] ? `CORTEX_STEP_SOURCE_${sourceNames[num(f, 3)]}` : undefined,
    executionId: str(f, 12),
    modelApiContentId: str(f, 35),
    toolCall: f.has(4) ? tool(sub(f, 4)) : undefined,
    modifiedToolCall: f.has(29) ? tool(sub(f, 29)) : undefined,
    sourceTrajectoryStepInfo: source.size
      ? compact({ trajectoryId: str(source, 1), stepIndex: num(source, 2), metadataIndex: num(source, 3), cascadeId: str(source, 4) })
      : undefined,
    modelUsage: usage.size
      ? compact({
          inputTokens: uint(usage, 2),
          outputTokens: uint(usage, 3),
          cacheWriteTokens: uint(usage, 4),
          cacheReadTokens: uint(usage, 5),
          thinkingOutputTokens: uint(usage, 9),
          responseOutputTokens: uint(usage, 10),
          messageId: str(usage, 7),
        })
      : undefined,
    modelInfo: info.size ? compact({ modelName: str(info, 8), chatModelName: str(info, 12), displayName: str(info, 20) }) : undefined,
    internalMetadata: f.has(26)
      ? {
          statusTransitions: repeated(sub(f, 26), 1).map(t =>
            compact({ updatedStatus: `CORTEX_STEP_STATUS_${statusNames[num(t, 1)] ?? 'UNSPECIFIED'}`, timestamp: timestamp(sub(t, 2)) }),
          ),
        }
      : undefined,
  });
}
function question(f: Fields): AgyRecord {
  return {
    questions: repeated(f, 1).map(q =>
      compact({
        question: str(q, 1),
        options: repeated(q, 2).map(o => compact({ id: str(o, 1), text: str(o, 2) })),
        isMultiSelect: !!num(q, 3),
        selectedOptionIds: strings(q, 4),
        writeInResponse: str(q, 5),
        skipped: !!num(q, 6),
      }),
    ),
  };
}
function subagentSpec(f: Fields): AgyRecord {
  return compact({ typeName: str(f, 1), role: str(f, 2), initialPrompt: str(f, 3), runAsTask: !!num(f, 9), modelOption: str(f, 12) });
}
function childResult(f: Fields): AgyRecord {
  return compact({ conversationId: str(f, 1), logAbsoluteUri: str(f, 2), workspaceUris: strings(f, 3) });
}
function invoke(f: Fields, generic = false): AgyRecord {
  return compact({
    subagents: repeated(f, generic ? 1 : 9).map(subagentSpec),
    results: repeated(f, generic ? 2 : 10).map(childResult),
    taskMode: !!num(f, generic ? 3 : 11),
    conversationId: generic ? undefined : str(f, 5),
  });
}
const kinds: Record<number, [string, number, string]> = {
  2: ['FINISH', 12, 'finish'],
  5: ['CODE_ACTION', 10, 'codeAction'],
  7: ['GREP_SEARCH', 13, 'grepSearch'],
  8: ['VIEW_FILE', 14, 'viewFile'],
  9: ['LIST_DIRECTORY', 15, 'listDirectory'],
  14: ['USER_INPUT', 19, 'userInput'],
  15: ['PLANNER_RESPONSE', 20, 'plannerResponse'],
  17: ['ERROR_MESSAGE', 24, 'errorMessage'],
  21: ['RUN_COMMAND', 28, 'runCommand'],
  23: ['CHECKPOINT', 30, 'checkpoint'],
  38: ['MCP_TOOL', 47, 'mcpTool'],
  82: ['NOTIFY_USER', 94, 'notifyUser'],
  90: ['EPHEMERAL_MESSAGE', 103, 'ephemeralMessage'],
  98: ['CONVERSATION_HISTORY', 111, 'conversationHistory'],
  101: ['SYSTEM_MESSAGE', 114, 'systemMessage'],
  127: ['INVOKE_SUBAGENT', 143, 'invokeSubagent'],
  132: ['GENERIC', 140, 'generic'],
  138: ['ASK_QUESTION', 154, 'askQuestion'],
};
function payload(kind: number, f: Fields): AgyRecord {
  switch (kind) {
    case 14:
      return compact({
        userResponse: str(f, 2),
        items: repeated(f, 3).map(i => compact({ text: str(i, 1) })),
        clientMessageId: str(f, 19),
        images: repeated(f, 5).map(image),
        media: repeated(f, 9).map(media),
      });
    case 15:
      return compact({
        response: str(f, 1),
        modifiedResponse: str(f, 8),
        thinking: str(f, 3),
        messageId: str(f, 6),
        toolCalls: repeated(f, 7).map(tool),
        stopReason: uint(f, 12),
        media: repeated(f, 20).map(media),
      });
    case 17:
      return compact({ error: error(sub(f, 3)), shouldShowUser: optionalBool(f, 5), shouldShowModel: optionalBool(f, 4) });
    case 21:
      return compact({
        commandLine: str(f, 23) ?? str(f, 1),
        proposedCommandLine: str(f, 25),
        cwd: str(f, 2),
        blocking: !!num(f, 11),
        commandId: str(f, 13),
        exitCode: f.has(6) ? Number(BigInt.asIntN(32, BigInt(uint(f, 6)!))) : undefined,
        combinedOutput: f.has(21) ? compact({ full: str(sub(f, 21), 1), truncated: str(sub(f, 21), 2) }) : undefined,
        shellName: str(f, 31),
      });
    case 8:
      return compact({ absolutePathUri: str(f, 1), content: str(f, 4) ?? str(f, 9), startLine: uint(f, 2), endLine: uint(f, 3) });
    case 7:
      return compact({ query: str(f, 1), rawOutput: str(f, 3), grepError: str(f, 5) });
    case 9:
      return compact({
        directoryPathUri: str(f, 1),
        children: strings(f, 2),
        results: repeated(f, 3).map(i => compact({ name: str(i, 1), isDir: !!num(i, 2), sizeBytes: uint(i, 4) })),
      });
    case 38:
      return compact({
        serverName: str(f, 1),
        toolCall: f.has(2) ? tool(sub(f, 2)) : undefined,
        resultString: str(f, 3),
        images: repeated(f, 5).map(image),
        media: repeated(f, 6).map(media),
      });
    case 23:
      return compact({ sessionSummary: str(f, 5), conversationTitle: str(f, 10), modelSummarizationFailed: !!num(f, 16) });
    case 82:
      return compact({ notificationContent: str(f, 2) });
    case 90:
      return compact({ content: str(f, 1) });
    case 101:
      return compact({
        message: str(f, 1),
        renderInfo: f.has(2) ? renderInfo(sub(f, 2)) : undefined,
        eventType: str(f, 3),
        agentMessage: f.has(4) ? compact({ hideFromUser: optionalBool(sub(f, 4), 11) }) : undefined,
      });
    case 127:
      return invoke(f);
    case 138:
      return question(f);
    case 132: {
      const result = sub(f, 2),
        any = sub(result, 6),
        typeUrl = str(any, 1),
        bytes = blob(any, 2);
      let typed: AgyRecord | undefined;
      if (bytes && typeUrl === 'type.googleapis.com/exa.cortex.core.tools.AskQuestion') typed = { askQuestion: question(fields(bytes)) };
      if (bytes && typeUrl === 'type.googleapis.com/exa.cortex.core.tools.InvokeSubagent')
        typed = { invokeSubagent: invoke(fields(bytes), true) };
      if (bytes && typeUrl === 'type.googleapis.com/exa.cortex.core.tools.RunCommand') {
        const r = fields(bytes);
        typed = {
          runCommand: compact({
            exitCode: num(r, 8) ? undefined : Number(BigInt.asIntN(32, BigInt(uint(r, 1) ?? 0))),
            commandLine: str(r, 6),
            cwd: str(r, 7),
            shellName: str(r, 5),
            combinedOutput: { full: str(result, 1) ?? '' },
          }),
        };
      }
      return compact({
        args: Object.fromEntries(repeated(f, 1).map(a => [str(a, 1) ?? '', str(a, 2) ?? ''])),
        result: compact({ result: str(result, 1), media: repeated(result, 4).map(media), fullOutputUri: str(result, 7) }),
        ...typed,
      });
    }
    default:
      return { unsupportedPayload: true };
  }
}
function asBlob(value: unknown): Uint8Array {
  if (value === null) return new Uint8Array();
  if (!(value instanceof Uint8Array)) refuse('invalid SQLite blob');
  return value;
}
function decodeStep(row: AgyRecord): AgyRecord {
  if (row.step_format !== 0 || row.has_subtrajectory !== 0) refuse('step format or subtrajectory');
  const f = fields(asBlob(row.step_payload));
  if (num(f, 1) !== row.step_type || num(f, 4) !== row.status) refuse('step tags disagree with SQLite columns');
  for (const [column, n] of [
    ['metadata', 5],
    ['error_details', 31],
    ['permissions', 133],
    ['task_details', 148],
  ] as const) {
    const embedded = blob(f, n);
    // agy 1.5.10 can store permission grants only in the full step payload.
    if (column === 'permissions' && row[column] === null) continue;
    if (!Buffer.from(asBlob(row[column])).equals(Buffer.from(embedded ?? []))) refuse(`${column} disagrees with payload`);
  }
  if (f.has(6)) refuse('embedded subtrajectory');
  const status = statusNames[row.status];
  if (!status) refuse('unknown step status');
  const kind = kinds[row.step_type];
  const out: AgyRecord = {
    type: `CORTEX_STEP_TYPE_${kind?.[0] ?? `UNKNOWN_${row.step_type}`}`,
    status: `CORTEX_STEP_STATUS_${status}`,
    metadata: metadata(sub(f, 5)),
  };
  if (f.has(31)) out.error = error(sub(f, 31));
  if (kind) {
    if (!f.has(kind[1])) refuse('step payload is missing');
    out[kind[2]] = payload(row.step_type, sub(f, kind[1]));
    if (row.step_type === 132)
      for (const [key, name] of [
        ['runCommand', 'RUN_COMMAND'],
        ['askQuestion', 'ASK_QUESTION'],
        ['invokeSubagent', 'INVOKE_SUBAGENT'],
      ] as const)
        if (out.generic[key]) {
          out[key] = out.generic[key];
          out.type = `CORTEX_STEP_TYPE_${name}`;
        }
  } else out.unsupportedPayload = true;
  return out;
}
/** One read-only transaction includes committed WAL updates and the current mutable branch. */
export function readAgySnapshot(geminiDir: string, conversationId: string): AgySnapshot | undefined {
  if (!AGY_ID.test(conversationId)) refuse('invalid conversation ID');
  const root = resolve(geminiDir),
    path = resolve(root, 'antigravity-cli', 'conversations', `${conversationId}.db`);
  if (!existsSync(path)) return undefined;
  const realRoot = realpathSync(root),
    realPath = realpathSync(path),
    rel = relative(realRoot, realPath);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) refuse('conversation escapes session root');
  for (const suffix of ['-wal', '-shm'])
    if (existsSync(`${realPath}${suffix}`)) {
      const sidecar = relative(realRoot, realpathSync(`${realPath}${suffix}`));
      if (isAbsolute(sidecar) || sidecar === '..' || sidecar.startsWith(`..${sep}`)) refuse('SQLite sidecar escapes session root');
    }
  const db = new DatabaseSync(realPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250; BEGIN;');
    if (db.prepare('PRAGMA user_version').get()?.user_version !== 1) refuse('SQLite schema version');
    const trajectories = db.prepare('SELECT trajectory_id,cascade_id FROM trajectory_meta').all();
    const t = trajectories[0];
    if (
      trajectories.length !== 1 ||
      t?.cascade_id !== conversationId ||
      typeof t.trajectory_id !== 'string' ||
      !AGY_ID.test(t.trajectory_id)
    )
      refuse('trajectory identity');
    const size = db
      .prepare(
        'SELECT count(*) AS n, sum(coalesce(length(step_payload),0)+coalesce(length(metadata),0)+coalesce(length(error_details),0)+coalesce(length(permissions),0)+coalesce(length(task_details),0)+coalesce(length(render_info),0)) AS bytes FROM steps',
      )
      .get()!;
    if (Number(size.n) > AGY_STEP_LIMIT || Number(size.bytes) > MAX_BYTES) refuse('conversation exceeds limit');
    const rows = db.prepare('SELECT * FROM steps ORDER BY idx').all();
    const steps = rows.map((row, i) => {
      if (row.idx !== i) refuse('noncontiguous step indices');
      return decodeStep(row);
    });
    const executorSize = db.prepare('SELECT count(*) AS n,sum(length(data)) AS bytes FROM executor_metadata').get()!;
    if (Number(executorSize.n) > AGY_STEP_LIMIT || Number(executorSize.bytes) + Number(size.bytes) > MAX_BYTES)
      refuse('executor metadata exceeds limit');
    const executors = db
      .prepare('SELECT idx,data FROM executor_metadata ORDER BY idx')
      .all()
      .map((row, i) => {
        if (row.idx !== i) refuse('noncontiguous executor indices');
        const f = fields(asBlob(row.data)),
          reason = num(f, 1);
        return compact({
          executionId: str(f, 9),
          terminationReason: `EXECUTOR_TERMINATION_REASON_${reasons[reason] ?? `UNKNOWN_${reason}`}`,
          lastStepIdx: num(f, 3),
          executionError: str(f, 12),
        });
      });
    const metaSize = db.prepare('SELECT count(*) AS n,sum(length(data)) AS bytes FROM trajectory_metadata_blob').get()!;
    if (Number(metaSize.n) > 1 || Number(metaSize.bytes) + Number(executorSize.bytes) + Number(size.bytes) > MAX_BYTES)
      refuse('trajectory metadata exceeds limit');
    const metaRows = db.prepare('SELECT id,data FROM trajectory_metadata_blob').all();
    if (metaRows.length > 1 || (metaRows[0] && metaRows[0].id !== 'main')) refuse('trajectory metadata shape');
    const metaBytes = metaRows[0] ? asBlob(metaRows[0].data) : undefined;
    if ((metaBytes?.length ?? 0) + Number(executorSize.bytes) + Number(size.bytes) > MAX_BYTES) refuse('trajectory metadata exceeds limit');
    const m = metaBytes ? fields(metaBytes) : undefined;
    const meta = m
      ? compact({
          createdAt: timestamp(sub(m, 2)),
          parentConversationId: str(m, 5),
          rootConversationId: str(m, 6),
          subagentSpec: m.has(8) ? subagentSpec(sub(m, 8)) : undefined,
        })
      : undefined;
    db.exec('ROLLBACK');
    return { conversationId, trajectoryId: t.trajectory_id, steps, executors, ...(meta ? { metadata: meta } : {}) };
  } finally {
    db.close();
  }
}
