import type { Project, Session } from '../../../../../packages/contracts/src/index.js';
import type { NativeBackendHost, NativeBackendProfileConfig, NativeControlMessage } from '../types.js';
import { safeProviderError } from './errors.js';
import type { CodexSessionRuntime } from './runtime.js';

type NativeListener = (message: NativeControlMessage) => void;

interface CodexSessionListeners {
  listeners: Set<NativeListener>;
  unsubscriptions: Map<NativeListener, () => void>;
  runtime?: CodexSessionRuntime;
  binding?: Promise<void>;
}

interface ListenersContext {
  runtime(sessionId: string): CodexSessionRuntime | undefined;
  ensureRuntime(host: NativeBackendHost, session: Session, project: Project, profile: NativeBackendProfileConfig): Promise<CodexSessionRuntime>;
  activeProfile(host: NativeBackendHost, session: Session, desired: NativeBackendProfileConfig): NativeBackendProfileConfig;
}

/**
 * The listeners that follow a session's status and events, and which runtime each is attached to.
 * It owns the subscriptions and re-attaches them when a runtime is replaced; it does not create
 * runtimes itself.
 */
export class CodexListeners {
  private readonly sessions = new Map<string, CodexSessionListeners>();

  constructor(private readonly ctx: ListenersContext) {}

  subscribe(host: NativeBackendHost, session: Session, profile: NativeBackendProfileConfig, listener: (message: NativeControlMessage) => void): () => void {
    const subscriptions = this.listenersFor(session.id);
    subscriptions.listeners.add(listener);
    const cleanup = () => {
      subscriptions.listeners.delete(listener);
      subscriptions.unsubscriptions.get(listener)?.();
      subscriptions.unsubscriptions.delete(listener);
      if (subscriptions.listeners.size === 0) {
        this.sessions.delete(session.id);
        subscriptions.runtime = undefined;
      }
    };
    if (!session.nativeSessionId) {
      listener({ type: 'status', status: { phase: 'offline' } });
      return cleanup;
    }
    const project = host.getProject(session.projectId);
    profile = this.ctx.activeProfile(host, host.getSession(session.id), profile);
    const current = this.ctx.runtime(session.id);
    if (current?.connection.belongsTo(project, profile) && current.transport?.isOnline) {
      current.connection.syncSessionBinding(session, project, profile);
      void this.bind(session.id, current).catch(error => {
        if (subscriptions.listeners.has(listener)) listener({ type: 'status', status: { phase: 'offline', connection: { state: 'failed', message: safeProviderError(error, profile.config) } } });
      });
    } else {
      void this.ctx.ensureRuntime(host, session, project, profile).then(runtime => this.bind(session.id, runtime)).catch(error => {
        if (subscriptions.listeners.has(listener)) {
          const message = safeProviderError(error, profile.config);
          listener({ type: 'status', status: { phase: 'offline', connection: { state: 'failed', message }, history: { state: 'error', message } } });
        }
      });
    }
    return cleanup;
  }

  private listenersFor(sessionId: string): CodexSessionListeners {
    let subscriptions = this.sessions.get(sessionId);
    if (!subscriptions) {
      subscriptions = { listeners: new Set(), unsubscriptions: new Map() };
      this.sessions.set(sessionId, subscriptions);
    }
    return subscriptions;
  }

  async bind(sessionId: string, runtime: CodexSessionRuntime): Promise<void> {
    const subscriptions = this.sessions.get(sessionId);
    if (!subscriptions || subscriptions.listeners.size === 0) return;
    if (subscriptions.runtime === runtime && subscriptions.listeners.size === subscriptions.unsubscriptions.size) return;
    if (subscriptions.binding) {
      await subscriptions.binding;
      if (subscriptions.runtime === runtime && subscriptions.listeners.size === subscriptions.unsubscriptions.size) return;
    }
    const task = (async () => {
      if (subscriptions.runtime !== runtime) {
        for (const unsubscribe of subscriptions.unsubscriptions.values()) unsubscribe();
        subscriptions.unsubscriptions.clear();
        subscriptions.runtime = runtime;
        // Prime the read-only transcript first. A loaded owner can then be attached with a
        // configuration-free resume; a cold stored thread remains a read-only observer.
        await runtime.prime().catch(() => undefined);
        await runtime.attachLoadedOwner().catch(() => undefined);
      }
      if (subscriptions.runtime !== runtime) return;
      for (const listener of subscriptions.listeners) {
        if (!subscriptions.unsubscriptions.has(listener)) subscriptions.unsubscriptions.set(listener, runtime.subscribe(listener));
      }
    })();
    subscriptions.binding = task;
    try { await task; }
    finally { if (subscriptions.binding === task) subscriptions.binding = undefined; }
  }

  clearAll(): void {
    for (const sessionId of this.sessions.keys()) this.clear(sessionId);
  }

  clear(sessionId: string): void {
    const subscriptions = this.sessions.get(sessionId);
    if (!subscriptions) return;
    for (const unsubscribe of subscriptions.unsubscriptions.values()) unsubscribe();
    subscriptions.unsubscriptions.clear();
    subscriptions.listeners.clear();
    subscriptions.runtime = undefined;
    this.sessions.delete(sessionId);
  }
}
