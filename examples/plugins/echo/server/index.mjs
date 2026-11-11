// The smallest Agent (docs/PLUGINS.md "Agent 后端"): it answers every message with the same text.
//
// An Agent plugin describes itself (profiles, capabilities, availability), opens a session, takes
// input in `send` and reports what happens. The core owns the rest: the command id, queueing, the
// durable delivery record, the journal and the transcript the clients draw. Nothing here touches a
// store, a route or a client, and nothing in the core or the clients knows an Agent called "echo".
//
// A dev package is plain code the server imports, so this file imports nothing. A package that is
// installed instead would run in its own process; Agent backends are refused there in this version.

const ID = 'example.echo';
const REPLY_DELAY_MS = 150;

/** Per Riffet session: the turn being answered, so `interrupt` can end it. */
const turns = new Map();

const at = () => new Date().toISOString();
const text = value => ({ type: 'text', text: value });

/** Everything one turn writes, pushed through the host: the Agent tells the core instead of being asked. */
function conclude(host, sessionId, turn, status) {
  turns.delete(sessionId);
  const events = status === 'completed'
    ? [{ type: 'agent_message_chunk', nativeId: `${turn.id}:reply`, nativeTurnId: turn.id, createdAt: at(), data: { content: text(turn.prompt) } }]
    : [];
  return host.transcript.ingest(sessionId, {
    events,
    turns: [{ edge: 'ended', turnId: turn.id, at: at(), status }],
    cursor: null,
    caughtUp: true,
  }).then(() => host.emit(sessionId, { type: 'status', status: { phase: 'idle' } }));
}

const backend = {
  protocolVersion: 1,
  id: ID,
  label: 'Echo',

  // Pure and synchronous: called wherever a profile list is shown.
  profiles: () => [{ id: 'default', name: 'Echo', isDefault: true, config: {} }],

  // What the clients may offer. Everything not claimed here is not offered.
  capabilities: () => ({
    modes: [{ id: 'agent', label: 'Echo' }], permissions: [],
    interactionTransport: 'none', supportsResume: true, supportsInterrupt: true, supportsHistory: false,
    supportsModelSelection: false, supportsModeSelection: false, supportsPermissionSelection: false,
  }),

  // Whether this machine can run the Agent. A real one would look for its CLI here.
  available: async () => ({ available: true }),

  // Opens (or resumes) a native session. The core stores the ids returned.
  async open(_host, { session }) {
    return { nativeSessionId: session.nativeSessionId ?? `echo-${session.id}`, status: { phase: 'idle' } };
  },

  // Takes the input. Three things are reported, each only once it is true: the input is
  // committed (the core never resends it from here on), the Agent accepted it (the echo of the
  // command id is what proves that), and the turn ended.
  async send(host, { context, commandId, runId, input }) {
    const sessionId = context.session.id;
    const turn = { id: `turn-${runId}`, prompt: input.text };
    const nativeSessionId = context.session.nativeSessionId ?? `echo-${sessionId}`;
    await host.commitDispatchFence(runId, { nativeSessionId, nativeTurnId: turn.id, renderedText: input.text });
    turns.set(sessionId, { ...turn, timer: undefined });
    host.emit(sessionId, { type: 'status', status: { phase: 'busy', activeTurnId: runId } });
    await host.transcript.ingest(sessionId, {
      events: [{ type: 'user_message_chunk', nativeId: `${turn.id}:prompt`, nativeTurnId: turn.id, createdAt: at(), data: { commandId, content: text(input.text) } }],
      turns: [{ edge: 'started', turnId: turn.id, at: at(), runId }],
      cursor: null,
      caughtUp: true,
    });
    // The reply comes later, as a second push.
    turns.get(sessionId).timer = setTimeout(() => { void conclude(host, sessionId, turn, 'completed'); }, REPLY_DELAY_MS);
    return { state: 'accepted', nativeTurnId: turn.id };
  },

  // Stops the running turn; without this the core refuses to stop this Agent's sessions.
  async interrupt(host, { session }) {
    const turn = turns.get(session.id);
    if (!turn) return;
    clearTimeout(turn.timer);
    await conclude(host, session.id, turn, 'cancelled');
  },

  // The session is gone for good: drop what is waiting.
  stop(_host, sessionId) {
    clearTimeout(turns.get(sessionId)?.timer);
    turns.delete(sessionId);
  },
};

export default {
  activate: () => ({ agentBackends: [backend] }),
};
