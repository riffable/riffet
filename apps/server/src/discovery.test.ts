import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const stop = vi.fn((callback?: () => void) => callback?.());
  const on = vi.fn();
  const publish = vi.fn(() => ({ stop, on }));
  const destroy = vi.fn((callback?: () => void) => callback?.());
  const Bonjour = vi.fn(() => ({ publish, destroy }));
  const mdnsNames = vi.fn(() => ['studio-mac.local']);
  return { Bonjour, publish, destroy, stop, on, mdnsNames };
});
vi.mock('bonjour-service', () => ({ default: mocks.Bonjour }));
vi.mock('./mdns-name.js', () => ({ mdnsNames: mocks.mdnsNames }));

const { startDiscovery } = await import('./discovery.js');

beforeEach(() => vi.clearAllMocks());

describe('startDiscovery', () => {
  it.each(['127.0.0.1', '127.0.0.2', 'localhost', '::1', '[::1]', '192.168.1.5', '2001:db8::1'])('publishes nothing when bound to %s', async host => {
    await expect(startDiscovery({ port: 4317, host, name: 'Riffet' })).resolves.toBeUndefined();
    expect(mocks.Bonjour).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('advertises a remotely reachable server and stops idempotently', async () => {
    const handle = await startDiscovery({ port: 4317, host: '0.0.0.0', name: 'Riffet', version: '0.1.0' });
    expect(handle).toBeDefined();
    // `host` is what bonjour-service copies into the SRV target and the A records, so it has to be
    // the name the network resolves rather than the platform default.
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'Riffet (studio-mac)', host: 'studio-mac.local', type: 'riffet', port: 4317, disableIPv6: true, txt: { version: '0.1.0', path: '/' } }));
    expect(mocks.on).toHaveBeenCalledWith('error', expect.any(Function));
    await handle!.stop();
    await handle!.stop();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
  });

  it('leaves the host to bonjour-service when this machine has no Bonjour name', async () => {
    mocks.mdnsNames.mockReturnValueOnce([]);
    const handle = await startDiscovery({ port: 4317, host: '0.0.0.0', name: 'Riffet' });
    expect(handle).toBeDefined();
    expect(mocks.publish).toHaveBeenCalledWith(expect.not.objectContaining({ host: expect.anything() }));
    await handle!.stop();
  });

  it('includes IPv6 only for a dual-stack wildcard listener', async () => {
    const handle = await startDiscovery({ port: 4317, host: '::', name: 'Riffet' });
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({ disableIPv6: false }));
    await handle!.stop();
  });
});
