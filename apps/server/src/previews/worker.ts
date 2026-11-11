import { parsePreview } from './parse.js';
import { escapeHtml, type PreviewTheme } from './document.js';
import type { PreviewKind } from './formats.js';

type Input = { data: Uint8Array; name: string; kind: PreviewKind; theme: PreviewTheme; databasePath?: string };

async function databasePreview(path: string): Promise<{ body: string }> {
  const { DatabaseSync, constants } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 100, readBigInts: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
    db.setAuthorizer((action, _arg1, _arg2, _database, trigger) => !trigger && [constants.SQLITE_SELECT, constants.SQLITE_READ].includes(action) ? constants.SQLITE_OK : constants.SQLITE_DENY);
    const tables = (db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' LIMIT 201").all() as { name: string; sql: string }[]).filter(table => !table.name.startsWith('sqlite_'));
    const parts: string[] = [];
    for (const table of tables.slice(0, 100)) {
      if (!/^\s*CREATE\s+TABLE\b/i.test(table.sql ?? '')) continue;
      try {
        const statement = db.prepare(`SELECT * FROM "${table.name.replace(/"/g, '""')}" LIMIT 201`);
        const columns = statement.columns().slice(0, 100);
        const rows = statement.all();
        const cell = (value: unknown) => value instanceof Uint8Array ? `<span class="muted">BLOB · ${value.byteLength} B</span>` : value === null ? '<span class="muted">NULL</span>' : escapeHtml(String(value).slice(0, 4096));
        parts.push(`<section><h3>${escapeHtml(table.name)}</h3><div class="table-scroll"><table><thead><tr>${columns.map(c => `<th>${escapeHtml(c.name)}</th>`).join('')}</tr></thead><tbody>${rows.slice(0, 200).map(row => `<tr>${columns.map(c => `<td>${cell(row[c.name])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${rows.length > 200 ? '<small>仅显示前 200 行</small>' : ''}</section>`);
      } catch { parts.push(`<section><h3>${escapeHtml(table.name)}</h3><pre>${escapeHtml(table.sql)}</pre></section>`); }
    }
    return { body: `<main>${parts.join('') || '<p>没有可预览的数据表</p>'}${tables.length > 100 ? '<small>仅显示前 100 张表</small>' : ''}</main>` };
  } finally { db.close(); }
}

process.once('message', async (input: Input) => {
  try {
    const result = input.kind === 'database' && input.databasePath ? await databasePreview(input.databasePath) : await parsePreview(input);
    if (Buffer.byteLength(JSON.stringify(result)) > 32 * 1024 * 1024) throw new Error('The preview result exceeds 32 MB');
    process.send?.({ ok: true, result }, () => process.exit(0));
  } catch (error) { process.send?.({ ok: false, message: error instanceof Error ? error.message.slice(0, 1000) : 'This file could not be parsed' }, () => process.exit(1)); }
});
