import { usageFromKeyInfo } from './usage.mjs';

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 1024 * 1024;
const text = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;

// A profile's own address and key win. The saved key goes only to the saved address: a profile that names
// another address brings its own key.
function connection(host, overrides = {}) {
  const own = text(overrides.apiEndpoint);
  const address = own ?? text(host.settings().baseUrl);
  const key = text(overrides.apiKey) ?? (own && own !== text(host.settings().baseUrl) ? undefined : text(host.secrets.get('apiKey')));
  if (!address) throw new Error('Set the LiteLLM address');
  let url;
  try { url = new URL(address); } catch { throw new Error('Invalid LiteLLM address'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTPS LiteLLM address without credentials, query or fragment; loopback HTTP is allowed');
  }
  if (!key || /[\0\r\n]/.test(key)) throw new Error('Set the LiteLLM API key');
  return { root: host.gateway.rootUrl(url.toString()), key };
}

async function readJson(response) {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error('LiteLLM response exceeds 1 MiB');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('LiteLLM response is empty');
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) { await reader.cancel(); throw new Error('LiteLLM response exceeds 1 MiB'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Invalid LiteLLM JSON'); }
}

export default {
  activate(host) {
    return {
      modelSources: [{
        id: 'riffet.litellm.models',
        role: 'adapter',
        label: 'LiteLLM',
        protocols: ['anthropic-messages', 'openai-responses'],
        overridable: ['apiEndpoint', 'apiKey'],
        resolve(overrides) {
          try {
            const { root, key } = connection(host, overrides);
            return { endpoints: {
              'anthropic-messages': { baseUrl: root },
              'openai-responses': { baseUrl: host.gateway.baseUrl(root, '/v1') },
            }, credential: { kind: 'static', key } };
          } catch (error) { return { reason: error.message }; }
        },
        async catalog(_backend, overrides) {
          const { root, key } = connection(host, overrides);
          try { return await host.gateway.fetchModels({ baseUrl: root, apiKey: key, timeoutMs: TIMEOUT_MS }); }
          catch { throw new Error('Could not read the LiteLLM model catalog'); }
        },
        async usage(overrides) {
          const { root, key } = connection(host, overrides);
          let response;
          try {
            // Without a `key` parameter LiteLLM answers for the calling key itself.
            response = await fetch(`${root}/key/info`, {
              method: 'GET', headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
              redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
            });
          } catch { throw new Error('Could not read LiteLLM usage'); }
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error(response.status >= 300 && response.status < 400
              ? 'LiteLLM usage redirects are not allowed' : `LiteLLM usage request failed (HTTP ${response.status})`);
          }
          return usageFromKeyInfo(await readJson(response), Date.now());
        },
      }],
    };
  },
};
