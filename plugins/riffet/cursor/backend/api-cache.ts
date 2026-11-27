import { createHash } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Agent, request as httpsRequest } from 'node:https';
import { request as httpRequest, Agent as HttpAgent } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CURSOR_API_CACHE_BUDGET } from '@contracts';
import { cursorApiFrontable, setCursorApiFront, type CursorLaunchProfile } from '../cli-driver.js';

/**
 * The read-only queries cursor-agent makes before it draws its prompt bar. Each costs a full round
 * trip, they come in serial waves, and a `--plugin-dir` alone adds four more `GetEffectiveUserPlugins`:
 * behind a remote gateway that is 9–12 s, and 25 s when the gateway is slow. Their answers change
 * rarely, so the last one is served at once and refreshed behind it; a change shows one start later.
 */
const STARTUP_QUERIES = new Set([
  '/aiserver.v1.DashboardService/GetMe',
  '/aiserver.v1.DashboardService/ListMarketplaces',
  '/aiserver.v1.DashboardService/GetUserPrivacyMode',
  '/aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam',
  '/aiserver.v1.DashboardService/GetEffectiveUserPlugins',
  '/aiserver.v1.DashboardService/GetManagedSkills',
  '/aiserver.v1.DashboardService/GetTeams',
  '/aiserver.v1.ServerConfigService/GetServerConfig',
  '/aiserver.v1.AiService/GetUsableModels',
  '/aiserver.v1.AiService/AvailableModels',
  '/aiserver.v1.AiService/GetDefaultModelForCli',
]);

/**
 * Where the CLI trades its API key for a one-hour access token. With the key in its environment and
 * an in-memory credential store (how Riffet launches it) it does so twice on every start, and each
 * token is new, so it would also defeat a cache keyed by token. The CLI trades again once its token
 * has under five minutes left; an answer with more than `tokenReuseMarginMs` left is handed out again.
 */
const EXCHANGE = '/auth/exchange_user_api_key';

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'content-length'];

interface Answer { status: number; headers: IncomingHttpHeaders; body: Buffer; at: number }

const digest = (...parts: Array<string | Buffer>): string => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex');
};

/** The `exp` of an exchange answer's access token, in ms; undefined when it is not one. */
function tokenOf(answer: Answer): { header: string; expiresAt: number } | undefined {
  try {
    const token = (JSON.parse(answer.body.toString('utf8')) as { accessToken?: unknown }).accessToken;
    if (typeof token !== 'string') return undefined;
    const exp = (JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? { header: `Bearer ${token}`, expiresAt: exp * 1000 } : undefined;
  } catch { return undefined; }
}

function endToEnd(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const kept = { ...headers };
  for (const name of HOP_BY_HOP) delete kept[name];
  return kept;
}

/**
 * A loopback front for one Cursor API endpoint (`--endpoint`). The startup queries above are answered
 * from memory, keyed by path, credential and request body, so one account's answer never reaches
 * another; everything else is streamed through untouched. The agent stream does not pass here: the
 * launch keeps `--agent-endpoint` on the real endpoint.
 *
 * The credential is the API key a token was traded for here, so answers survive the hourly token
 * change; a token this front did not hand out stands for itself.
 */
export class CursorApiCache {
  private readonly upstream: URL;
  private readonly agent: Agent | HttpAgent;
  private readonly answers = new Map<string, Answer>();
  private readonly pending = new Map<string, Promise<Answer>>();
  /** Exchange answers by API key and body, with their token's expiry. */
  private readonly tokens = new Map<string, { answer: Answer; expiresAt: number }>();
  /** Tokens handed out here: the digest of their `Authorization` to the digest of the key's. */
  private readonly issued = new Map<string, { credential: string; expiresAt: number }>();
  private bytes = 0;
  private server?: Server;
  private listening?: Promise<string>;

  /**
   * `portFile` keeps the port across restarts: a CLI outlives the server in its tmux pane and keeps
   * calling the address it was launched with, so the next server listens there again. Without one of its
   * own, the front takes `legacyPortFile` over, with the CLIs launched against it.
   */
  constructor(upstream: string, private readonly portFile: string, private readonly legacyPortFile?: string) {
    this.upstream = new URL(upstream);
    this.agent = this.upstream.protocol === 'https:' ? new Agent({ keepAlive: true }) : new HttpAgent({ keepAlive: true });
  }

  /** The front's own URL, for `--endpoint`. */
  start(): Promise<string> {
    this.listening ??= (async () => {
      const kept = await this.keptPort();
      let port: number;
      try { port = await this.listen(kept ?? 0); }
      catch (error) {
        // Taken by something else: CLIs launched against it lose the API until they are relaunched.
        if (kept === undefined || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
        port = await this.listen(0);
      }
      if (port !== kept) await this.keepPort(port);
      return `http://127.0.0.1:${port}`;
    })();
    return this.listening;
  }

  private listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res));
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        this.server = server;
        resolve((server.address() as AddressInfo).port);
      });
    });
  }

  private async keptPort(): Promise<number | undefined> {
    const own = await readPort(this.portFile);
    if (own !== undefined || !this.legacyPortFile) return own;
    try {
      await mkdir(dirname(this.portFile), { recursive: true, mode: 0o700 });
      await rename(this.legacyPortFile, this.portFile);
    } catch { return undefined; }
    return readPort(this.portFile);
  }

  private async keepPort(port: number): Promise<void> {
    await mkdir(dirname(this.portFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.portFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ port }), { mode: 0o600 });
    await rename(temporary, this.portFile);
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.answers.clear();
    this.tokens.clear();
    this.issued.clear();
    this.bytes = 0;
    this.agent.destroy();
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '/').split('?')[0]!;
    const exchange = path === EXCHANGE;
    if (req.method !== 'POST' || !(exchange || STARTUP_QUERIES.has(path))) {
      this.pass(req, res);
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', () => res.destroy());
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (exchange) this.exchange(req, res, body);
      else this.query(path, req, res, body);
    });
  }

  private query(path: string, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
    const key = digest(path, this.credentialOf(req.headers.authorization ?? ''), body);
    const kept = this.answers.get(key);
    const fresh = this.fetch(key, req, body).then(answer => { this.keep(key, answer); return answer; });
    if (kept && Date.now() - kept.at < CURSOR_API_CACHE_BUDGET.maxStaleMs) {
      // Most recently used goes to the end, which is what eviction reads from the other side.
      this.answers.delete(key);
      this.answers.set(key, kept);
      this.reply(res, kept);
      fresh.catch(() => undefined);
      return;
    }
    fresh.then(answer => this.reply(res, answer), () => res.destroy());
  }

  /** No refresh behind a reused token: a new one would only change the credential under the next start. */
  private exchange(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
    const authorization = req.headers.authorization ?? '';
    const key = digest(EXCHANGE, authorization, body);
    const kept = this.tokens.get(key);
    if (kept && kept.expiresAt - Date.now() > CURSOR_API_CACHE_BUDGET.tokenReuseMarginMs) {
      this.reply(res, kept.answer);
      return;
    }
    // Plain JSON, so the token's expiry can be read.
    this.fetch(`token:${key}`, req, body, { 'accept-encoding': 'identity' }).then(answer => {
      this.keepToken(key, digest(authorization), answer);
      this.reply(res, answer);
    }, () => res.destroy());
  }

  private credentialOf(authorization: string): string {
    const own = digest(authorization);
    const issued = this.issued.get(own);
    if (!issued) return own;
    if (issued.expiresAt > Date.now()) return issued.credential;
    this.issued.delete(own);
    return own;
  }

  private keepToken(key: string, credential: string, answer: Answer): void {
    this.tokens.delete(key);
    const token = answer.status === 200 ? tokenOf(answer) : undefined;
    if (!token) return;
    const now = Date.now();
    this.tokens.set(key, { answer, expiresAt: token.expiresAt });
    this.issued.set(digest(token.header), { credential, expiresAt: token.expiresAt });
    for (const map of [this.tokens, this.issued] as Array<Map<string, { expiresAt: number }>>) {
      for (const [id, entry] of map) {
        if (entry.expiresAt <= now || map.size > CURSOR_API_CACHE_BUDGET.maxEntries) map.delete(id);
      }
    }
  }

  /** One upstream request per key at a time; concurrent asks share it. */
  private fetch(key: string, req: IncomingMessage, body: Buffer, headers: Record<string, string> = {}): Promise<Answer> {
    let fresh = this.pending.get(key);
    if (fresh) return fresh;
    fresh = new Promise<Answer>((resolve, reject) => {
      const upstream = (this.upstream.protocol === 'https:' ? httpsRequest : httpRequest)({
        host: this.upstream.hostname, port: this.upstream.port || undefined, method: req.method,
        path: this.upstreamPath(req.url ?? '/'),
        headers: { ...endToEnd(req.headers), ...headers, host: this.upstream.host, 'content-length': String(body.length) },
        agent: this.agent,
      }, response => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => resolve({ status: response.statusCode ?? 502, headers: endToEnd(response.headers), body: Buffer.concat(chunks), at: Date.now() }));
      });
      upstream.on('error', reject);
      upstream.end(body);
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, fresh);
    return fresh;
  }

  private keep(key: string, answer: Answer): void {
    const old = this.answers.get(key);
    if (old) { this.answers.delete(key); this.bytes -= old.body.length; }
    // Anything but a 200 (an expired credential, a gateway error) must not be replayed, nor the 200 before it.
    if (answer.status !== 200 || answer.body.length > CURSOR_API_CACHE_BUDGET.maxBytes) return;
    this.answers.set(key, answer);
    this.bytes += answer.body.length;
    for (const [oldest, entry] of this.answers) {
      if (this.answers.size <= CURSOR_API_CACHE_BUDGET.maxEntries && this.bytes <= CURSOR_API_CACHE_BUDGET.maxBytes) break;
      this.answers.delete(oldest);
      this.bytes -= entry.body.length;
    }
  }

  private reply(res: ServerResponse, answer: Answer): void {
    res.writeHead(answer.status, { ...answer.headers, 'content-length': String(answer.body.length) });
    res.end(answer.body);
  }

  private pass(req: IncomingMessage, res: ServerResponse): void {
    const upstream = (this.upstream.protocol === 'https:' ? httpsRequest : httpRequest)({
      host: this.upstream.hostname, port: this.upstream.port || undefined, method: req.method,
      path: this.upstreamPath(req.url ?? '/'),
      headers: { ...req.headers, host: this.upstream.host },
      agent: this.agent,
    }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    req.pipe(upstream);
  }

  /** The endpoint may carry a path prefix; the CLI's paths go under it. */
  private upstreamPath(path: string): string {
    const prefix = this.upstream.pathname.replace(/\/$/, '');
    return `${prefix}${path}`;
  }
}

async function readPort(file: string): Promise<number | undefined> {
  try {
    const port = (JSON.parse(await readFile(file, 'utf8')) as { port?: unknown }).port;
    return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
  } catch { return undefined; }
}

/**
 * The fronts of one activation: one per gateway address, shared by the providers on it (answers are keyed by
 * credential, so accounts stay apart). Each port is kept in its own file under `cursor-api-fronts/`. The single
 * front of earlier versions, for the default provider only, kept `cursor-api-front.json`: only the first front
 * created here may take it over, so which gateway gets it follows the order providers are served in, not a race.
 */
export class CursorApiFronts {
  private readonly fronts = new Map<string, { cache: CursorApiCache; url: Promise<string | undefined> }>();
  private readonly served = new WeakMap<CursorLaunchProfile, Promise<void>>();
  private readonly pointed = new Set<CursorLaunchProfile>();
  private closed = false;
  private legacyOffered = false;

  constructor(private readonly stateDir: string) {}

  /**
   * Starts the front of `launch`'s gateway and points the launch at it. Settles once the launch may run, also when
   * the front failed (the launch then calls the gateway directly) or the launch is not fronted at all.
   */
  serve(launch: CursorLaunchProfile): Promise<void> {
    if (this.closed || !cursorApiFrontable(launch, true)) return Promise.resolve();
    let served = this.served.get(launch);
    if (!served) {
      served = this.front(launch.apiEndpoint!).then(url => {
        if (!url || this.closed) return;
        setCursorApiFront(launch, url);
        this.pointed.add(launch);
      });
      this.served.set(launch, served);
    }
    return served;
  }

  private front(upstream: string): Promise<string | undefined> {
    let front = this.fronts.get(upstream);
    if (!front) {
      const name = createHash('sha256').update(upstream).digest('hex').slice(0, 16);
      const legacy = this.legacyOffered ? undefined : join(this.stateDir, 'cursor-api-front.json');
      this.legacyOffered = true;
      const cache = new CursorApiCache(upstream, join(this.stateDir, 'cursor-api-fronts', `${name}.json`), legacy);
      const url = cache.start().catch((error: unknown) => {
        console.warn(`[riffet] Cursor startup cache unavailable; launches use the endpoint directly: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      });
      this.fronts.set(upstream, front = { cache, url });
    }
    return front.url;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const launch of this.pointed) setCursorApiFront(launch, undefined);
    this.pointed.clear();
    await Promise.all([...this.fronts.values()].map(front => front.cache.close()));
    this.fronts.clear();
  }
}
