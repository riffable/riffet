import { describe, expect, it } from 'vitest';
import { isPairingCode, pairingHandoffUrl, parsePairingQr, parseServerAddress } from './pairing-qr';

describe('Riffet pairing QR handoff', () => {
  it('reads the server address and one-use code, including a TLS front door on its default port', () => {
    const pairing = parsePairingQr(JSON.stringify({ v: 1, scheme: 'https', host: 'riffet.example.test', port: 443, code: '2345abcd', name: 'Desk' }));
    expect(pairing).toEqual({ origin: 'https://riffet.example.test', code: '2345ABCD' });
    expect(pairingHandoffUrl(pairing!)).toBe('https://riffet.example.test/#pair=2345ABCD');
  });

  it('rejects unrelated codes and an address that could alter the destination URL', () => {
    expect(parsePairingQr('https://riffet.example.test')).toBeUndefined();
    expect(parsePairingQr(JSON.stringify({ v: 2, host: 'riffet.example.test', port: 4337, code: '2345ABCD' }))).toBeUndefined();
    expect(parsePairingQr(JSON.stringify({ v: 1, host: 'riffet.example.test/evil', port: 4337, code: '2345ABCD' }))).toBeUndefined();
  });

  it('reads a typed server address the way the phone does', () => {
    expect(parseServerAddress('192.168.1.10')).toBe('http://192.168.1.10:4337');
    expect(parseServerAddress(' Mac.local:8080/x?y ')).toBe('http://mac.local:8080');
    expect(parseServerAddress('[fe80::1]:4317')).toBe('http://[fe80::1]:4317');
    expect(parseServerAddress('https://riffet.example.test')).toBe('https://riffet.example.test');
    expect(parseServerAddress('fe80::1:4317')).toBeUndefined();
    expect(parseServerAddress('host:70000')).toBeUndefined();
    expect(isPairingCode(' 2345 abcd ')).toBe(true);
    expect(isPairingCode('2345ABCO')).toBe(false);
  });
});
