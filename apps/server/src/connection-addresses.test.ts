import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ networkInterfaces: vi.fn(), mdnsNames: vi.fn(() => ['studio.local']) }));
vi.mock('node:os', () => ({ networkInterfaces: mocks.networkInterfaces }));
vi.mock('./mdns-name.js', () => ({ mdnsNames: mocks.mdnsNames }));
const { connectionAddresses, listenerHosts } = await import('./connection-addresses.js');

beforeEach(() => {
  mocks.networkInterfaces.mockReturnValue({
    lo0: [{ address: '127.0.0.1', internal: true }],
    en0: [{ address: '192.168.1.20', internal: false }, { address: 'fe80::1%en0', internal: false }, { address: '2001:db8::20', internal: false }],
    en8: [{ address: '10.0.0.20', internal: false }],
    en11: [{ address: '169.254.1.20', internal: false }],
  });
});

describe('connection addresses follow the actual listener', () => {
  it('keeps a loopback server local for Mac pairing', () => {
    expect(connectionAddresses({ bindHost: '127.0.0.1', port: 4337, scheme: 'http', authority: 'localhost:4337' }))
      .toEqual({ host: '127.0.0.1', hosts: ['127.0.0.1'], port: 4337, scheme: 'http', baseUrl: 'http://127.0.0.1:4337', localOnly: true });
  });

  it('advertises only the concrete interface it binds', () => {
    expect(listenerHosts('10.0.0.20')).toEqual(['10.0.0.20']);
    expect(connectionAddresses({ bindHost: '10.0.0.20', port: 4337, scheme: 'http', authority: '127.0.0.1:4337' }).host).toBe('10.0.0.20');
  });

  it('offers LAN IPv4 first for IPv4 wildcard, without unspecified or wrong-family addresses', () => {
    expect(listenerHosts('0.0.0.0')).toEqual(['192.168.1.20', '10.0.0.20', 'studio.local']);
    const result = connectionAddresses({ bindHost: '0.0.0.0', port: 4337, scheme: 'http', authority: 'localhost:4337' });
    expect(result.host).toBe(result.hosts[0]);
    expect(result.baseUrl).toBe('http://192.168.1.20:4337');
    expect(result.localOnly).toBe(false);
  });

  it('prefers the interface the requesting client actually reached', () => {
    const result = connectionAddresses({ bindHost: '0.0.0.0', port: 4337, scheme: 'http', authority: '10.0.0.20:4337' });
    expect(result.hosts).toEqual(['10.0.0.20', '192.168.1.20', 'studio.local']);
    expect(result.baseUrl).toBe('http://10.0.0.20:4337');
  });

  it('preserves an allowlisted TLS front door without assigning its port to LAN interfaces', () => {
    expect(connectionAddresses({ bindHost: '127.0.0.1', port: 4337, scheme: 'https', authority: 'riffet.example.com' }))
      .toEqual({ host: 'riffet.example.com', hosts: ['riffet.example.com'], port: 443, scheme: 'https', baseUrl: 'https://riffet.example.com:443', localOnly: false });
  });

  it('preserves a front door that remaps the port', () => {
    const result = connectionAddresses({ bindHost: '0.0.0.0', port: 4337, scheme: 'http', authority: 'riffet.example.com:8080' });
    expect(result.hosts).toEqual(['riffet.example.com']);
    expect(result.port).toBe(8080);
  });

  it('formats IPv6 origins and supports dual-stack listeners', () => {
    expect(listenerHosts('::')).toEqual(['192.168.1.20', '10.0.0.20', '2001:db8::20', 'studio.local']);
    const result = connectionAddresses({ bindHost: '2001:db8::20', port: 4337, scheme: 'http' });
    expect(result.baseUrl).toBe('http://[2001:db8::20]:4337');
  });

  it('never advertises an unspecified request host', () => {
    expect(connectionAddresses({ bindHost: '0.0.0.0', port: 4337, scheme: 'http', authority: '0.0.0.0:4337' }).host).toBe('192.168.1.20');
  });

  it('does not advertise a new DHCP address that Host validation has not accepted', () => {
    const result = connectionAddresses({ bindHost: '0.0.0.0', port: 4337, scheme: 'http',
      authority: 'localhost:4337', allowedHosts: new Set(['localhost', '127.0.0.1', 'studio.local']) });
    expect(result.hosts).toEqual(['studio.local']);
  });
});
