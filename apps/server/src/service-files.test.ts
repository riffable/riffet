import { describe, expect, it } from 'vitest';
import { buildLaunchAgentPlist, buildSystemdUnit, systemdValue, xmlEscape } from './service-files.js';

/**
 * A service manager hands a background process no login shell, so the environment snapshot written
 * here is the whole environment the daemon gets. An escaping mistake does not fail loudly — it
 * silently produces a different PATH, which is exactly the class of bug this work removed.
 */
describe('buildLaunchAgentPlist', () => {
  it('escapes the XML entities a PATH can contain', () => {
    const plist = buildLaunchAgentPlist({
      label: 'local.riffet',
      programArguments: ['/opt/node&bin/node', '/repo with spaces/dist/cli.js', 'serve'],
      environment: { PATH: '/a&b:/c<d>', CURSOR_CONFIG_DIR: '/Users/me/.cursor' },
      logPath: '/state/server.log',
    });
    expect(plist).toContain('<string>/a&amp;b:/c&lt;d&gt;</string>');
    expect(plist).toContain('<string>/opt/node&amp;bin/node</string>');
    expect(plist).toContain('<string>/repo with spaces/dist/cli.js</string>');
    // A quoted attribute-level escape would break the plist, so the raw characters must be gone.
    expect(plist).not.toMatch(/<string>[^<]*[<>][^<]*<\/string>/);
  });

  it('carries every variable the service needs and a single log path for both streams', () => {
    const plist = buildLaunchAgentPlist({ label: 'l', programArguments: ['n'], environment: { PATH: '/bin', JAVA_HOME: '/jdk' }, logPath: '/log' });
    expect(plist).toContain('<key>PATH</key><string>/bin</string>');
    expect(plist).toContain('<key>JAVA_HOME</key><string>/jdk</string>');
    expect(plist.match(/<key>StandardOutPath<\/key><string>\/log<\/string>/g)).toHaveLength(1);
    expect(plist).toContain('<key>StandardErrorPath</key><string>/log</string>');
  });

  it('is well-formed enough to parse as XML', () => {
    const plist = buildLaunchAgentPlist({ label: 'local.riffet', programArguments: ['/n'], environment: { PATH: '/bin' }, logPath: '/log' });
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(plist.trimEnd().endsWith('</plist>')).toBe(true);
    expect(xmlEscape("it's")).toBe('it&apos;s');
  });
});

describe('buildSystemdUnit', () => {
  it('escapes the specifier and quoting characters systemd would otherwise reinterpret', () => {
    expect(systemdValue('/a%b')).toBe('"/a%%b"');
    expect(systemdValue('/a"b')).toBe('"/a\\"b"');
    expect(systemdValue('/a\\b')).toBe('"/a\\\\b"');
  });

  it('writes one Environment line per variable and quotes the ExecStart arguments', () => {
    const unit = buildSystemdUnit({
      description: 'Riffet',
      programArguments: ['/opt/node', '/repo/dist/cli.js', 'serve', '--host', '0.0.0.0'],
      environment: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
      workingDirectory: '/repo',
      logPath: '/state/server.log',
    });
    expect(unit).toContain('Environment="PATH=/usr/bin:/bin"');
    expect(unit).toContain('Environment="LANG=en_US.UTF-8"');
    expect(unit).toContain('ExecStart="/opt/node" "/repo/dist/cli.js" "serve" "--host" "0.0.0.0"');
    expect(unit).toContain('WorkingDirectory=/repo/\n');
    expect(unit).toContain('StandardOutput=append:/state/server.log');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('keeps the working directory as one literal path, escaping only specifiers', () => {
    const unit = buildSystemdUnit({
      description: 'Riffet',
      programArguments: ['/opt/node'],
      environment: {},
      workingDirectory: '/repo with spaces/%n/"quoted"/back\\slash\\ ',
      logPath: '/state/server.log',
    });
    expect(unit).toContain('WorkingDirectory=/repo with spaces/%%n/"quoted"/back\\slash\\ /\n');
  });

  it('runs in the foreground so systemd owns the process lifecycle', () => {
    const unit = buildSystemdUnit({ description: 'Riffet', programArguments: ['n', 'c', 'serve'], environment: {}, workingDirectory: '/r', logPath: '/l' });
    expect(unit).toContain('Type=simple');
    expect(unit).not.toContain('start --state-dir');
  });

  it('keeps a value on one line, because a unit file has no way to continue one', () => {
    const unit = buildSystemdUnit({ description: 'Riffet', programArguments: ['n'], environment: { PATH: '/bin' }, workingDirectory: '/r', logPath: '/l' });
    for (const line of unit.split('\n')) expect(line).not.toMatch(/[\r]/);
    expect(unit.split('\n').filter(line => line.startsWith('Environment='))).toHaveLength(1);
  });
});
