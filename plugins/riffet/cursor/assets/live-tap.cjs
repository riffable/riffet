'use strict';
/**
 * Live text of a Cursor CLI step, read off the CLI's own agent stream.
 *
 * The CLI's chat store gets one checkpoint per step, after the model is done with it, so a step that
 * only writes text is not on disk until the turn is over. The text does arrive in deltas on the agent
 * stream, so Riffet loads this module into the CLI (`NODE_OPTIONS=--require`, launches it makes only)
 * and it writes the step in flight to `$RIFFET_CURSOR_LIVE/<conversation id>.json`:
 *
 *     { v, pid, turn, at, prompt?, step, sealed, turnEnds, ended?, broken?, parts: [{ type: 'reasoning' | 'text', text }] }
 *
 * - `turn` is the request id the store files the turn's prompt under; `prompt` is that prompt, which
 *   the store only records at the step's checkpoint as well. A run with a prompt is written as soon as
 *   the request names it, before any output: that is the CLI taking the prompt.
 * - `step` names the step; `sealed` says its checkpoint arrived or the run ended, so the store has (or
 *   is about to have) all of it. The file is replaced by the conversation's next step and removed when
 *   the CLI exits.
 * - `ended` is when the server ended the run's turn (`InteractionUpdate.turn_ended`); `broken` is when
 *   the stream closed without that, which a stop, a network error or a retry does. `turnEnds` says this
 *   tap writes both, so a reader can tell an open turn from a tap that predates them
 *   (docs/TURN-LIFECYCLE.md §4.6).
 *
 * The stream is Connect over HTTP/2 (`/agent.v1.AgentService/Run`), or over HTTP/1.1 when the CLI is
 * set to (`network.useHttp1ForAgent`): the server's half streams from `/agent.v1.AgentService/RunSSE`
 * and the client's half goes as unary `/aiserver.v1.BidiService/BidiAppend` calls, tied by
 * `x-request-id`. Either way the bytes are only observed, never changed, and any failure here leaves
 * the CLI as it would be without this module.
 */
const { isMainThread } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash, randomBytes } = require('node:crypto');

const RUN = '/agent.v1.AgentService/Run';
const RUN_SSE = '/agent.v1.AgentService/RunSSE';
const BIDI_APPEND = '/aiserver.v1.BidiService/BidiAppend';
const FLUSH_MS = 150;
const PART_LIMIT = 1024 * 1024;
const REQUEST_LIMIT = 64;
const CONVERSATION_ID = /^[A-Za-z0-9._-]{1,128}$/;

// ---- protobuf -------------------------------------------------------------------------------

/** The fields of a protobuf message: [number, varint | bytes]. Fixed-width values are skipped. */
function fields(buffer) {
  const out = [];
  let at = 0;
  const varint = () => {
    let value = 0, shift = 0;
    for (;;) {
      if (at >= buffer.length || shift > 63) throw new Error('bad varint');
      const byte = buffer[at++];
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return value;
      shift += 7;
    }
  };
  while (at < buffer.length) {
    const key = varint(), wire = key % 8, number = Math.floor(key / 8);
    if (!Number.isSafeInteger(key) || number < 1) throw new Error('bad field');
    if (wire === 0) out.push([number, varint()]);
    else if (wire === 2) {
      const length = varint();
      if (!Number.isSafeInteger(length) || at + length > buffer.length) throw new Error('truncated');
      out.push([number, buffer.subarray(at, at + length)]);
      at += length;
    } else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else throw new Error('bad wire type');
  }
  return out;
}

const field = (list, number) => { const hit = list.find(([n]) => n === number); return hit ? hit[1] : undefined; };
const message = (list, number) => { const value = field(list, number); return value instanceof Uint8Array ? fields(value) : undefined; };
const string = (list, number) => { const value = field(list, number); return value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : undefined; };

/**
 * What a run is about, from its `AgentClientMessage{1 run_request}`: `AgentRunRequest{5 conversation_id,
 * 25 run_id, 2 action: ConversationAction{1 user_message_action: {1 user_message: {1 text}}}}`.
 */
function runRequest(bytes) {
  const request = message(fields(bytes), 1);
  if (!request) return undefined;
  const conversation = string(request, 5);
  if (!conversation || !CONVERSATION_ID.test(conversation)) return undefined;
  const userMessage = message(message(message(request, 2) ?? [], 1) ?? [], 1);
  const prompt = userMessage && string(userMessage, 1);
  const requestedModel = string(message(request, 9) ?? [], 1) || string(message(request, 3) ?? [], 1);
  return { conversation, run: string(request, 25), ...(prompt ? { prompt } : {}), ...(requestedModel ? { requestedModel } : {}) };
}

/** Atomic, metadata-only inbox. Linking the complete temporary file never replaces an earlier event. */
function persistUsage(dir, observation, diagnostic = false) {
  if (!dir) return;
  let temporary, fd;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const bytes = JSON.stringify(observation);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const file = path.join(dir, `${diagnostic ? 'diagnostic-' : ''}${hash}.json`);
    temporary = path.join(dir, `.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    try { fs.linkSync(temporary, file); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    fs.unlinkSync(temporary); temporary = undefined;
    // The queue survives CLI exit; a reader acknowledges files only after recording them elsewhere.
    fd = fs.openSync(dir, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch { /* capture must never interfere with the CLI */ }
  finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
    if (temporary) try { fs.unlinkSync(temporary); } catch { /* best effort */ }
  }
}

// ---- Connect framing ------------------------------------------------------------------------

function decompress(bytes, encoding) {
  if (!encoding || encoding === 'identity') return bytes;
  if (encoding === 'gzip') return zlib.gunzipSync(bytes);
  if (encoding === 'br') return zlib.brotliDecompressSync(bytes);
  if (encoding === 'deflate') return zlib.inflateSync(bytes);
  throw new Error(`unsupported encoding ${encoding}`);
}

/** Splits a Connect stream into its envelopes: `[flags u8][length u32be][payload]`, flag 1 compressed, 2 the end. */
class Envelopes {
  constructor(encoding) { this.encoding = encoding; this.buffer = Buffer.alloc(0); }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    const out = [];
    while (this.buffer.length >= 5) {
      const length = this.buffer.readUInt32BE(1);
      if (this.buffer.length < 5 + length) break;
      const flags = this.buffer[0];
      const payload = this.buffer.subarray(5, 5 + length);
      this.buffer = this.buffer.subarray(5 + length);
      out.push({ end: Boolean(flags & 2), payload: flags & 1 ? decompress(payload, this.encoding) : payload });
    }
    return out;
  }
}

// ---- the live step --------------------------------------------------------------------------

/** One run of the agent stream and the step it is in. */
class Live {
  constructor(dir, usageDir, request, turn) {
    this.order = ++runs;
    this.dir = dir;
    this.usageDir = usageDir;
    this.request = request;
    this.turn = turn;
    this.startedAt = Date.now();
    this.at = new Date(this.startedAt).toISOString();
    this.terminals = new Map();
    this.info = undefined;
    this.step = 0;
    this.sealed = true;
    this.parts = [];
    this.size = 0;
    this.firstDeltaAt = undefined;
    this.lastDeltaAt = undefined;
    this.timer = undefined;
    this.closed = false;
    this.ended = undefined;
    this.broken = undefined;
  }

  /** The run's request became known: which conversation, and the prompt that began it. */
  identify(info) {
    if (this.info) return;
    this.info = info;
    for (const terminal of this.terminals.values()) this.captureUsage(terminal);
    if (info.run && !this.turn) this.turn = info.run;
    if (!this.closed && (this.parts.length || info.prompt)) this.flush();
  }

  /** `AgentServerMessage`: 1 interaction_update, 3 conversation_checkpoint_update. */
  serverMessage(bytes) {
    for (const [number, value] of fields(bytes)) {
      if (number === 3) this.seal();
      else if (number === 1 && value instanceof Uint8Array) this.update(fields(value));
    }
  }

  /** `InteractionUpdate`: 1 text_delta, 4 thinking_delta, 16 step_started, 17 step_completed, 14 turn_ended. */
  update(list) {
    for (const [number, value] of list) {
      if (!(value instanceof Uint8Array)) continue;
      if (number === 1 || number === 4) {
        const delta = fields(value);
        // A server notice (`TextDeltaUpdate.is_server_notice`) is the CLI's, not the model's.
        if (number === 1 && field(delta, 2)) continue;
        const text = string(delta, 1);
        if (text) this.append(number === 1 ? 'text' : 'reasoning', text);
      } else if (number === 14) {
        this.turnEnded(value);
        this.ended ??= Date.now();
        this.settle();
      } else if (number === 16 || number === 17) this.seal();
    }
  }

  /** TurnEnded's optional int64 counts: absence stays absent, including for terminal-only streams. */
  turnEnded(bytes) {
    const rawUsage = {}, invalid = [];
    const keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];
    for (const [number, value] of fields(bytes)) {
      const key = keys[number - 1];
      if (!key) continue;
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) rawUsage[key] = value;
      else { delete rawUsage[key]; invalid.push(key); }
    }
    // A repeated terminal on this stream is a replay, not another agent invocation.
    const fingerprint = JSON.stringify([keys.map(key => rawUsage[key]), [...new Set(invalid)].sort()]);
    if (this.terminals.has(fingerprint)) return;
    const terminal = { endedAt: Date.now(), rawUsage };
    this.terminals.set(fingerprint, terminal);
    if (invalid.length) persistUsage(this.usageDir, {
      v: 1, kind: 'invalid-usage', requestId: this.request, startedAt: this.startedAt,
      endedAt: terminal.endedAt, fields: invalid,
    }, true);
    this.captureUsage(terminal);
  }

  captureUsage(terminal) {
    const common = { requestId: this.request, startedAt: this.startedAt, endedAt: terminal.endedAt };
    if (!this.info?.conversation || !this.info.run) {
      persistUsage(this.usageDir, { v: 1, kind: 'unidentified-terminal', ...common }, true);
      return;
    }
    persistUsage(this.usageDir, {
      v: 1, nativeSessionId: this.info.conversation, nativeTurnId: this.info.run, ...common,
      ...(this.info.requestedModel ? { requestedModel: this.info.requestedModel } : {}), rawUsage: terminal.rawUsage,
    });
  }

  append(type, text) {
    if (this.closed) return;
    // Output after an end means the run went on: its turn is not over after all.
    this.ended = undefined;
    if (this.sealed) {
      this.step += 1;
      this.sealed = false;
      this.parts = [];
      this.size = 0;
      this.firstDeltaAt = undefined;
      this.lastDeltaAt = undefined;
    }
    if (this.size + text.length > PART_LIMIT) return;
    const now = Date.now();
    if (this.firstDeltaAt === undefined) this.firstDeltaAt = now;
    this.lastDeltaAt = now;
    this.size += text.length;
    const last = this.parts.at(-1);
    if (last?.type === type) last.text += text;
    else this.parts.push({ type, text });
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS).unref();
  }

  /**
   * The step's checkpoint arrived, or the run is over. The file stays: the CLI writes the checkpoint to
   * its store only after this, so the reader keeps showing the step until the store has moved on.
   */
  seal() {
    if (this.sealed) return;
    this.sealed = true;
    this.flush();
  }

  /** Seals the step and writes the file even when the step was sealed already: the run's end is news. */
  settle() {
    if (this.sealed) this.flush();
    else this.seal();
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const conversation = this.info?.conversation;
    if (!conversation || (!this.parts.length && !this.info.prompt)) return;
    // A retried run takes the conversation over; the one it replaced must not write over it on its way out.
    if ((owners.get(conversation)?.order ?? 0) > this.order) return;
    owners.set(conversation, this);
    const snapshot = {
      v: 1, pid: process.pid, turn: this.turn ?? this.request, at: this.at, ...(this.info.prompt ? { prompt: this.info.prompt } : {}),
      ...(this.info.run ? { run: this.info.run } : {}),
      ...(this.info.requestedModel ? { requestedModel: this.info.requestedModel } : {}),
      ...(this.firstDeltaAt !== undefined ? { firstDeltaAt: this.firstDeltaAt } : {}),
      ...(this.lastDeltaAt !== undefined ? { lastDeltaAt: this.lastDeltaAt } : {}),
      step: `${this.request}:${this.step}`, sealed: this.sealed, turnEnds: true,
      ...(this.ended !== undefined ? { ended: this.ended } : {}),
      ...(this.broken !== undefined ? { broken: this.broken } : {}),
      parts: this.parts,
    };
    const temporary = path.join(this.dir, `.${conversation}.${process.pid}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600 });
      fs.renameSync(temporary, path.join(this.dir, `${conversation}.json`));
    } catch { /* the conversation still shows each step once it is checkpointed */ }
  }

  close() {
    if (this.closed) return;
    if (this.ended === undefined) this.broken ??= Date.now();
    this.settle();
    this.closed = true;
  }
}

/** The latest run to write each conversation's file; runs are numbered as they start. */
const owners = new Map();
let runs = 0;
/** HTTP/1.1: what each request id's `BidiAppend` said, and the `RunSSE` streams waiting to hear it. */
const requests = new Map();
const waiting = new Map();

function remember(request, info) {
  requests.set(request, info);
  while (requests.size > REQUEST_LIMIT) requests.delete(requests.keys().next().value);
  const live = waiting.get(request);
  live?.identify(info);
  if (live?.closed) waiting.delete(request);
}

/** Feeds a response stream's bytes to [live] as they arrive, without consuming them. */
function observe(stream, live, encoding) {
  let envelopes;
  let broken = false;
  const push = stream.push;
  stream.push = function (chunk, ...rest) {
    if (!broken && !live.closed && chunk !== null && chunk?.length) {
      try {
        envelopes ??= new Envelopes(encoding());
        for (const envelope of envelopes.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)) {
          if (envelope.end) live.close();
          else live.serverMessage(envelope.payload);
        }
      } catch { broken = true; live.close(); }
    }
    return push.call(this, chunk, ...rest);
  };
  for (const event of ['end', 'close', 'error', 'aborted']) stream.once(event, () => live.close());
}

/**
 * Hands what a request writes to [done]: the whole body once it ends, or with [envelope] its first
 * Connect envelope as soon as that is complete. The stream's own methods come back after that.
 */
function collect(stream, done, envelope) {
  const write = stream.write, end = stream.end;
  const chunks = [];
  let size = 0, expected = Infinity, finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    stream.write = write;
    stream.end = end;
    try { done(Buffer.concat(chunks)); } catch { /* not a request this module understands */ }
  };
  const take = chunk => {
    if (finished || !chunk || typeof chunk === 'function' || !chunk.length) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(bytes);
    size += bytes.length;
    if (envelope && expected === Infinity && size >= 5) expected = 5 + Buffer.concat(chunks).readUInt32BE(1);
    if (size >= expected) finish();
  };
  stream.write = function (chunk, ...rest) {
    try { take(chunk); } catch { finished = true; }
    return write.call(this, chunk, ...rest);
  };
  stream.end = function (chunk, ...rest) {
    try { take(chunk); finish(); } catch { finished = true; }
    return end.call(this, chunk, ...rest);
  };
}

// ---- HTTP/1.1 -------------------------------------------------------------------------------

function header(request, name) {
  const value = request.getHeader(name);
  return typeof value === 'string' ? value : Array.isArray(value) ? value[0] : undefined;
}

function tapHttp1(dir, usageDir, request) {
  const url = request.path ?? '';
  if (!url.endsWith(RUN_SSE) && !url.endsWith(BIDI_APPEND)) return;
  const id = header(request, 'x-request-id');
  if (!id) return;
  if (url.endsWith(BIDI_APPEND)) {
    if (requests.has(id)) return;
    // `BidiAppendRequest{1 data (hex), 2 request_id, 3 append_seqno, 4 data_binary}`, whose data is an `AgentClientMessage`.
    collect(request, body => {
      const list = fields(decompress(body, header(request, 'content-encoding')));
      const hex = string(list, 1), binary = field(list, 4);
      const data = binary instanceof Uint8Array ? binary : hex ? Buffer.from(hex, 'hex') : undefined;
      const info = data && runRequest(data);
      if (info) remember(id, info);
    }, false);
    return;
  }
  const live = new Live(dir, usageDir, id, header(request, 'x-original-request-id'));
  waiting.set(id, live);
  while (waiting.size > REQUEST_LIMIT) waiting.delete(waiting.keys().next().value);
  const known = requests.get(id);
  if (known) live.identify(known);
  request.once('response', response => {
    const encoding = response.headers['connect-content-encoding'];
    observe(response, live, () => (typeof encoding === 'string' ? encoding : 'gzip'));
  });
  request.once('close', () => {
    // A terminal can arrive before BidiAppend identifies it. Keep a bounded wait for that identity.
    if (live.info && waiting.get(id) === live) waiting.delete(id);
  });
}

// ---- HTTP/2 ---------------------------------------------------------------------------------

function tapHttp2(dir, usageDir, headers, stream) {
  if (!String(headers?.[':path'] ?? '').endsWith(RUN)) return;
  const id = String(headers['x-request-id'] ?? '') || `h2:${Date.now()}`;
  const original = headers['x-original-request-id'];
  const live = new Live(dir, usageDir, id, typeof original === 'string' ? original : undefined);
  const sent = headers['connect-content-encoding'];
  collect(stream, body => {
    const first = new Envelopes(typeof sent === 'string' ? sent : 'gzip').push(body)[0];
    const info = first && !first.end ? runRequest(first.payload) : undefined;
    if (info) live.identify(info);
  }, true);
  let encoding = 'gzip';
  stream.once('response', response => { if (typeof response['connect-content-encoding'] === 'string') encoding = response['connect-content-encoding']; });
  observe(stream, live, () => encoding);
}

// ---- install --------------------------------------------------------------------------------

function install(dir, usageDir) {
  for (const name of ['node:https', 'node:http']) {
    const module = require(name);
    const request = module.request;
    module.request = function (...args) {
      const made = request.apply(this, args);
      try { tapHttp1(dir, usageDir, made); } catch { /* observed nothing */ }
      return made;
    };
  }
  const http2 = require('node:http2');
  const connect = http2.connect;
  http2.connect = function (...args) {
    const session = connect.apply(this, args);
    try {
      const request = session.request;
      session.request = function (headers, ...rest) {
        const stream = request.call(this, headers, ...rest);
        try { tapHttp2(dir, usageDir, headers, stream); } catch { /* observed nothing */ }
        return stream;
      };
    } catch { /* observed nothing */ }
    return session;
  };
  // The files say what this process is streaming; once it is gone they say nothing.
  process.once('exit', () => {
    for (const conversation of owners.keys()) try { fs.unlinkSync(path.join(dir, `${conversation}.json`)); } catch { /* already gone */ }
  });
}

(() => {
  const dir = process.env.RIFFET_CURSOR_LIVE;
  const usageDir = process.env.RIFFET_CURSOR_USAGE;
  // Only the CLI itself: its launcher exports CURSOR_INVOKED_AS and runs `index.js`. A wrapper's own
  // node process passes the environment on untouched, so the CLI it starts still gets it.
  if (!dir || !isMainThread || !process.env.CURSOR_INVOKED_AS || path.basename(process.argv[1] ?? '') !== 'index.js') return;
  // Everything the CLI runs (shell tools, MCP servers, hooks) inherits its environment.
  delete process.env.RIFFET_CURSOR_LIVE;
  delete process.env.RIFFET_CURSOR_USAGE;
  const options = (process.env.NODE_OPTIONS ?? '').replace(/(?:^|\s)(?:--require|-r)[\s=](?:"[^"]*live-tap\.cjs"|\S*live-tap\.cjs)/g, '').trim();
  if (options) process.env.NODE_OPTIONS = options;
  else delete process.env.NODE_OPTIONS;
  try { install(dir, usageDir); } catch { /* the CLI runs as it would without this module */ }
})();
