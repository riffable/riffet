

/**
 * A CLI model id: single token, optionally parameterized (`claude-opus-4-8[context=1m,effort=high]`).
 * Shared by the list parser and the switch guard so they can never disagree.
 */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+@\[\]=,-]{0,199}$/;

/**
 * `cursor-agent --list-models` prints `<id> - <name>` per line. The name is cosmetic, but the
 * picker reads much better with it; a line without a separator still yields its id.
 */
export function parseModelList(output: string): Array<{ value: string; name: string }> {
  const ansi = /\u001b\[[0-?]*[ -/]*[@-~]/g;
  const seen = new Set<string>();
  const models: Array<{ value: string; name: string }> = [];
  for (const raw of output.replace(ansi, '').split(/\r?\n/)) {
    const line = raw.trim().replace(/^(?:[-*•✓✔]\s*|\d+[.)]\s*)/, '');
    if (!line || /^(?:available models|models?:?|model id\s+-\s+model name|[-=\s]+)$/i.test(line)) continue;
    const separator = /\s+-\s+/.exec(line);
    const value = (separator ? line.slice(0, separator.index) : line).replace(/\s+\((?:current|default)\)$/i, '').trim();
    // Anything that is not a single model token is status text or a table heading.
    if (!MODEL_ID.test(value) || seen.has(value)) continue;
    seen.add(value);
    const name = separator ? line.slice(separator.index + separator[0].length).trim() : '';
    models.push({ value, name: name || value });
    if (models.length >= 200) break;
  }
  return models;
}

/** A short, user-facing reason for an empty `--list-models` result. Output is already key-redacted. */
export function describeModelListFailure(result: { code: number | null; stdout: string; stderr: string; timedOut: boolean } | undefined, executable: string, timeoutMs: number): string {
  if (!result) return `无法启动 CLI「${executable}」`;
  if (result.timedOut) return `CLI 在 ${Math.round(timeoutMs / 1000)} 秒内没有返回模型列表`;
  const output = `${result.stderr}\n${result.stdout}`.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  if (result.code === null && /\bENOENT\b/.test(output)) return `找不到 CLI 命令「${executable}」，请检查设置中的 CLI 入口或服务进程的 PATH`;
  if (result.code === null && /\bEACCES\b/.test(output)) return `CLI「${executable}」没有执行权限`;
  const detail = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)?.slice(0, 200);
  if (result.code !== 0) return `CLI 退出码 ${result.code ?? '未知'}${detail ? `：${detail}` : ''}`;
  return detail ? `CLI 输出中没有可识别的模型：${detail}` : 'CLI 没有列出任何模型';
}
