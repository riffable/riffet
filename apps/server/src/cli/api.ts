import type { DaemonRecord } from './context.js';
import { serverUrl } from './context.js';
import { CliError } from './ui.js';

export interface Reply<T = Record<string, unknown>> { status: number; body: T & { error?: { code?: string; message?: string; details?: unknown } } }

/**
 * A signed-in session with the local server, as the Web client has one: the access token is exchanged
 * for a cookie and a CSRF token once, and neither leaves this process.
 */
export class Api {
  private constructor(readonly base: string, private readonly headers: Record<string, string>) {}

  static async login(record: Pick<DaemonRecord, 'host' | 'port'>, token: string, fetcher: typeof fetch = fetch): Promise<Api> {
    const base = serverUrl(record);
    let login: Response;
    try {
      login = await fetcher(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }), signal: AbortSignal.timeout(5000) });
    } catch (error) {
      throw new CliError(`Could not reach Riffet at ${base}: ${error instanceof Error ? error.message : String(error)}`, ['riffet status']);
    }
    if (!login.ok) throw new CliError(`The running server refused the access token (HTTP ${login.status})`, ['Check that --state-dir points at the directory this server uses']);
    const { csrfToken } = await login.json() as { csrfToken?: unknown };
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).find(value => value?.startsWith('cw_session='));
    if (typeof csrfToken !== 'string' || !cookie) throw new CliError('The running server did not return a login session');
    return new Api(base, { cookie, 'x-csrf-token': csrfToken });
  }

  /** The reply whatever its status. */
  async request<T = Record<string, unknown>>(method: string, path: string, body?: unknown, timeoutMs = 120_000, fetcher: typeof fetch = fetch): Promise<Reply<T>> {
    const response = await fetcher(this.base + path, {
      method,
      headers: { ...this.headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) as Reply<T>['body'] };
  }

  /** The body of a successful reply; anything else throws the server's own message. */
  async call<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const reply = await this.request<T>(method, path, body, timeoutMs);
    if (reply.status < 200 || reply.status >= 300) throw new CliError(reply.body.error?.message ?? `The server answered HTTP ${reply.status}`);
    return reply.body as T;
  }
}
