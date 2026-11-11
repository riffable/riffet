// An OpenAI-compatible gateway as a model source (docs/PLUGINS.md).
//
// This file runs in its own process, under the operating system's sandbox: it can only reach the
// network because the package asked for the `network` capability and the user granted it.
// `resolve()` has to answer synchronously, because the Codex driver builds its launch environment
// synchronously. Asking the gateway is asynchronous, so that happens in `prepare()`: the host awaits
// it before reading a catalog, and keeps its last answer for `resolve()`.

const PROBE_TIMEOUT_MS = 8000;

export default {
  activate(host) {
    /** The gateway's last answer, by address: `{ models }` or `{ error }`. */
    const answers = new Map();

    // A profile may carry its own address and key; otherwise the plugin's settings apply.
    const addressOf = overrides => (overrides.apiEndpoint || host.settings().baseUrl || '').trim().replace(/\/+$/, '');
    const keyOf = overrides => overrides.apiKey || host.secrets.get('apiKey');

    async function ask(overrides) {
      const baseUrl = addressOf(overrides);
      if (!baseUrl) return;
      try {
        const models = await host.gateway.fetchModels({ baseUrl, apiKey: keyOf(overrides), timeoutMs: PROBE_TIMEOUT_MS });
        answers.set(baseUrl, { models });
      } catch (error) {
        answers.set(baseUrl, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    return {
      modelSources: [{
        // An installed package's source ids are `<plugin id>.<name>`: a bare id could be a built-in's.
        id: `${host.id}.gateway`,
        label: 'Example gateway',
        backends: ['codex'],
        resolve(overrides) {
          const baseUrl = addressOf(overrides);
          const key = keyOf(overrides);
          if (!baseUrl) return { reason: 'Set the gateway address in the plugin settings' };
          if (!key) return { reason: 'Set the secret key in the plugin settings' };
          const failed = answers.get(baseUrl)?.error;
          return {
            // Codex appends its wire path to a base that already carries the version segment.
            codexBaseUrl: host.gateway.baseUrl(baseUrl, '/v1'),
            credential: { kind: 'static', key },
            ...(failed ? { reason: `The gateway did not answer: ${failed}` } : {}),
          };
        },
        prepare: ask,
        async catalog(_backend, overrides) {
          await ask(overrides);
          const answer = answers.get(addressOf(overrides));
          if (!answer) throw new Error('Set the gateway address in the plugin settings');
          if (answer.error) throw new Error(answer.error);
          return answer.models;
        },
      }],
      status: async () => host.settings().baseUrl && host.secrets.get('apiKey')
        ? { state: 'ready', message: host.settings().baseUrl }
        : { state: 'attention', message: 'Set the gateway address and the secret key' },
    };
  },
};
