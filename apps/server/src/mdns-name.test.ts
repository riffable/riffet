import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { mdnsNames, mdnsNamesFrom } from './mdns-name.js';

describe('mdnsNamesFrom', () => {
  it('yields nothing for a name that cannot be published', () => {
    expect(mdnsNamesFrom('')).toEqual([]);
    expect(mdnsNamesFrom('localhost')).toEqual([]);
    expect(mdnsNamesFrom('LOCALHOST.local')).toEqual([]);
    expect(mdnsNamesFrom('0.0.0.0')).toEqual([]);
    expect(mdnsNamesFrom('[::]')).toEqual([]);
    expect(mdnsNamesFrom('bad name')).toEqual([]);
    expect(mdnsNamesFrom('-bad-name')).toEqual([]);
  });
});

describe('mdnsNames', () => {
// The regression this file exists for: `os.hostname()` is the DHCP name on macOS, and building a
  // `.local` name out of it yields a host nothing answers, which silently killed the pairing QR.
  it.skipIf(process.platform !== 'darwin')('prefers the Bonjour name over the DHCP one', () => {
    const bonjour = execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim();
    expect(mdnsNames()).toEqual(mdnsNamesFrom(bonjour));
  });
});
