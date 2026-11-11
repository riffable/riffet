import { describe, expect, it } from 'vitest';
import { activateLocale } from './i18n';
import { errorMessage, HttpError } from './errors';

describe('server error text', () => {
  it('words a code in the interface language rather than the developer message', async () => {
    const missing = new HttpError(404, 'The skill is not in the current configuration', 'EXTENSION_NOT_FOUND', undefined, { subject: 'skill' });
    expect(errorMessage(missing, '无法读取')).toBe('Skill 不在当前配置中');
    // Not in the catalog yet: the server's own message beats a generic fallback.
    expect(errorMessage(new HttpError(400, 'Use at most 20 attachments', 'INVALID_ATTACHMENTS'), '无法发送')).toBe('Use at most 20 attachments');
    expect(errorMessage(new HttpError(500, '', 'INTERNAL'), '无法发送')).toBe('无法发送');
    // Not yet moved to codes: the server's Chinese is shown as it is.
    expect(errorMessage(new HttpError(409, '会话正在归档', 'ARCHIVED_SESSION'), '无法发送')).toBe('会话正在归档');
    // An external tool's own output.
    expect(errorMessage(new HttpError(422, 'fatal: not a git repository', 'GIT_OPERATION_FAILED'), '无法提交')).toBe('fatal: not a git repository');
    await activateLocale('en');
    try {
      expect(errorMessage(missing)).toBe('The skill is not in the current configuration');
      expect(errorMessage(new HttpError(403, 'Read-only: 由 DSH 管理', 'EXTENSION_READ_ONLY', undefined, { subject: 'reason', reason: '由 DSH 管理' }))).toBe('由 DSH 管理');
    } finally { await activateLocale('zh-Hans'); }
  });
});
