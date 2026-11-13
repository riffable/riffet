import type { PluginManifest, SourceOverrides } from '@riffet/plugin-api';
import { hostMatchesDeclared } from '../plugins/declarations.js';

// Where an installed package's model traffic may go. A source that declares `contributes.modelSources[].hosts`
// reaches those hosts and the addresses the user typed: the profile's own endpoint for the call, and the package's
// `text` settings (a package cannot write its settings). Literal host names only; nothing is resolved.

const DEFAULT_PORT: Record<string, number> = { 'http:': 80, 'https:': 443 };

/** `host:port` with the port always spelled out, in the form `hostMatchesDeclared` reads. */
const endpointOf = (url: URL): string => `${url.hostname}:${url.port || DEFAULT_PORT[url.protocol] || ''}`;

function httpUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined; } catch { return undefined; }
}

/** The IPv4 address inside an IPv4-mapped IPv6 literal, which `URL` writes in hexadecimal. */
function dotted(hostname: string): string {
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (!mapped) return bare;
  const high = parseInt(mapped[1]!, 16), low = parseInt(mapped[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export const isLoopbackOrUnspecified = (hostname: string): boolean => {
  const bare = dotted(hostname);
  return bare === 'localhost' || bare.endsWith('.localhost') || bare === '::1' || bare === '::' || bare === '0.0.0.0' || bare.startsWith('127.');
};

export const isLinkLocal = (hostname: string): boolean => {
  const bare = dotted(hostname);
  return bare.startsWith('169.254.') || /^fe[89ab][0-9a-f]?:/.test(bare);
};

export class AddressRefused extends Error {}

export class SourceAddresses {
  /** Endpoints of the profile overrides of the calls now running: the user's choice, which a catalog fetch made for that call may follow. */
  private readonly active = new Map<string, number>();

  constructor(
    private readonly manifest: Pick<PluginManifest, 'contributes' | 'settings'>,
    private readonly settings: () => Readonly<Record<string, string>>,
    private readonly serverPorts: () => readonly number[] = () => [],
  ) {}

  /** What one source declares; undefined when it declares none (not limited). */
  declaredFor(sourceId: string): readonly string[] | undefined {
    return this.manifest.contributes?.modelSources?.find(source => source.id === sourceId)?.hosts;
  }

  /** Everything every source declares; undefined when none does. */
  private declaredAny(): readonly string[] | undefined {
    const hosts = (this.manifest.contributes?.modelSources ?? []).flatMap(source => source.hosts ?? []);
    return (this.manifest.contributes?.modelSources ?? []).some(source => source.hosts) ? hosts : undefined;
  }

  /** `host:port` of what the user typed: this call's profile endpoint, and the package's own text settings that are addresses. */
  private entered(overrides?: SourceOverrides): string[] {
    const values = this.settings();
    const typed = (this.manifest.settings ?? []).filter(field => field.kind === 'text').map(field => values[field.key]);
    // `active` already holds `host:port`; the rest are addresses as the user typed them.
    return [...this.active.keys(), ...[...(overrides ? [overrides.apiEndpoint] : []), ...typed].flatMap(value => { const url = httpUrl(value); return url ? [endpointOf(url)] : []; })];
  }

  private permitted(url: URL, declared: readonly string[], overrides?: SourceOverrides): boolean {
    const endpoint = endpointOf(url);
    return hostMatchesDeclared(endpoint, declared) || this.entered(overrides).some(item => item === endpoint);
  }

  /** Whether an address a source resolved to may be used. A source that declares no hosts is not limited. */
  allows(sourceId: string, address: string, overrides: SourceOverrides): boolean {
    const declared = this.declaredFor(sourceId);
    if (!declared) return true;
    const url = httpUrl(address);
    return Boolean(url) && this.permitted(url!, declared, overrides);
  }

  /** Runs a call to the child made for these overrides, so a catalog fetch it makes may reach the endpoint the profile names. */
  async during<T>(overrides: SourceOverrides, run: () => Promise<T>): Promise<T> {
    const url = httpUrl(overrides.apiEndpoint);
    const endpoint = url ? endpointOf(url) : undefined;
    if (endpoint) this.active.set(endpoint, (this.active.get(endpoint) ?? 0) + 1);
    try { return await run(); } finally {
      if (endpoint) { const left = (this.active.get(endpoint) ?? 1) - 1; if (left > 0) this.active.set(endpoint, left); else this.active.delete(endpoint); }
    }
  }

  /** The server fetches for the package, so the sandbox's closed ports do not apply: refuse this server's own port, link-local addresses and, when hosts are declared, anything else. Throws `AddressRefused`. */
  checkFetch(url: URL): void {
    const port = Number(url.port || DEFAULT_PORT[url.protocol]);
    if (isLoopbackOrUnspecified(url.hostname) && this.serverPorts().includes(port)) throw new AddressRefused('the address is this server');
    const declared = this.declaredAny();
    const entered = this.entered().includes(endpointOf(url));
    if (isLinkLocal(url.hostname) && !entered) throw new AddressRefused('link-local addresses are not reachable from a package');
    if (declared && !this.permitted(url, declared)) throw new AddressRefused(`${url.host} is not among the hosts the package declares`);
  }
}
