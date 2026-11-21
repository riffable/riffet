import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';

/**
 * The `ssh` transport (docs/SERVER-LINKS.md §6): `ssh <host> <riffet> link stdio --role …` on the other machine
 * connects to that machine's own server over loopback and relays the tunnel's bytes on standard input and output.
 * The other server can therefore keep listening only on 127.0.0.1. SSH runs without a terminal and without prompts:
 * the daemon cannot answer one, so the key must already be usable (an agent or an unencrypted key).
 */
export function sshTransport(options: { host: string; remoteCommand: string; role: 'primary' | 'reverse'; join?: string }): Duplex {
  const command = [options.remoteCommand, 'link', 'stdio', '--role', options.role, ...(options.join ? ['--join', options.join] : [])]
    .map(part => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`)).join(' ');
  const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ExitOnForwardFailure=yes', '--', options.host, command], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
  const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
  child.once('exit', code => {
    if (!stream.destroyed) stream.destroy(code ? new Error(`ssh exited with ${code}${stderr.trim() ? `: ${stderr.trim().split('\n').pop()}` : ''}`) : undefined);
  });
  child.once('error', error => stream.destroy(error));
  stream.once('close', () => { if (child.exitCode === null) child.kill('SIGTERM'); });
  return stream;
}
