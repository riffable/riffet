import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../errors.js';
import { completeForPlugin } from './models.js';

const chat = { backendId: 'claude' as const, profileId: 'p', model: 'chat-model' };
const chosen = { backendId: 'claude' as const, profileId: 'p', model: 'translation-model' };
const profiles = () => [{ id: 'p', name: 'Gateway', config: { apiEndpoint: 'https://gateway.example', apiKey: 'k' } }] as never;
const uses = [{ id: 'acme.tr/translation', title: { en: 'Translation' }, fallback: 'chat' as const }, { id: 'acme.tr/strict', title: { en: 'Strict' } }];
const error = (code: string, message: string, status: number, details?: unknown) => new AppError(code, message, status, details);

describe('host.models.complete', () => {
  it('runs a declared use on its own choice, else its fallback, and refuses a use the plugin does not declare', async () => {
    const complete = vi.fn(async (request: { model: string }) => request.model);
    const run = (use: string | undefined, choices: { chat?: typeof chat; use?: typeof chosen }) => completeForPlugin(
      { ...(use ? { use } : {}), system: 's', content: 'c', maxOutputTokens: 100 }, uses,
      { chat: () => choices.chat, use: () => choices.use }, profiles, { complete: complete as never, error });
    await expect(run('acme.tr/translation', { chat, use: chosen })).resolves.toContain('translation-model');
    await expect(run('acme.tr/translation', { chat })).resolves.toContain('chat-model');
    await expect(run(undefined, { chat, use: chosen })).resolves.toContain('chat-model');
    await expect(run('acme.tr/strict', { chat })).rejects.toMatchObject({ code: 'PLUGIN_MODEL_NOT_CHOSEN', statusCode: 409, details: { use: 'acme.tr/strict' } });
    await expect(run('other.plugin/translation', { chat, use: chosen })).rejects.toMatchObject({ code: 'PLUGIN_MODEL_USE_FOREIGN', statusCode: 403 });
    expect(complete).toHaveBeenCalledTimes(3);
  });
});
