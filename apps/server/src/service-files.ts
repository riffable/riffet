/**
 * Service-manager files, as pure functions.
 *
 * `install-service` writes a launchd plist on macOS and a systemd user unit on Linux, and this
 * session can only execute one of them. Keeping the text generation separate from the `launchctl` /
 * `systemctl` calls means both can be checked on both platforms in CI, which matters because the
 * environment snapshot is what a background service has instead of a login shell: a value that is
 * not escaped correctly silently becomes a different PATH.
 */

/** launchd's plist is XML, so the five predefined entities have to be escaped. */
export function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * systemd expands `%` specifiers in unit values and treats `"` / `\` specially inside a quoted
 * value, so a PATH or a home directory containing one must be escaped or it becomes something else.
 */
export function systemdValue(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
}

export function buildLaunchAgentPlist(input: {
  label: string;
  programArguments: string[];
  environment: Record<string, string>;
  logPath: string;
}): string {
  const argumentsXml = input.programArguments.map(value => `<string>${xmlEscape(value)}</string>`).join('');
  const variablesXml = Object.entries(input.environment)
    .map(([name, value]) => `<key>${xmlEscape(name)}</key><string>${xmlEscape(value)}</string>`)
    .join('');
  const log = xmlEscape(input.logPath);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${xmlEscape(input.label)}</string>`,
    `<key>ProgramArguments</key><array>${argumentsXml}</array>`,
    `<key>EnvironmentVariables</key><dict>${variablesXml}</dict>`,
    '<key>RunAtLoad</key><true/>',
    '<key>KeepAlive</key><true/>',
    `<key>StandardOutPath</key><string>${log}</string>`,
    `<key>StandardErrorPath</key><string>${log}</string>`,
    '</dict></plist>',
    '',
  ].join('\n');
}

export function buildSystemdUnit(input: {
  description: string;
  programArguments: string[];
  environment: Record<string, string>;
  workingDirectory: string;
  logPath: string;
}): string {
  const environment = Object.entries(input.environment).map(([name, value]) => `Environment=${systemdValue(`${name}=${value}`)}`);
  return [
    '[Unit]',
    `Description=${input.description}`,
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${input.programArguments.map(systemdValue).join(' ')}`,
    ...environment,
    // This field expands specifiers but does not unquote or unescape a command argument.
    // A trailing slash preserves trailing whitespace/backslashes through the unit line parser.
    `WorkingDirectory=${input.workingDirectory.replaceAll('%', '%%')}/`,
    'Restart=on-failure',
    'RestartSec=3',
    `StandardOutput=append:${input.logPath}`,
    `StandardError=append:${input.logPath}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}
