// Runs inside the process an installed plugin package lives in (docs/PLUGIN_ARCHITECTURE.md "独立包").
//
// The server starts this file with Node's permission model on: it may read this file, the package
// directory and the plugin's own state directory, write only the latter, and start no child
// process, worker, addon or WASI instance. It imports nothing but Node built-ins because nothing
// else is readable. The package's server entry is loaded here and handed a proxy `PluginHost`
// whose calls go back to the server over IPC; the server decides what each one may do.
//
// Protocol: JSON messages `{ id, method, params }` and `{ id, result | error }` in both directions, one per line:
// the server's on stdin, this process's on stdout (packages/plugin-api/src/runtime/protocol.ts). The package's
// own writes to stdout (`console.log`) go to stderr, which the server keeps only as the last lines of a failure.

import { pathToFileURL } from 'node:url';

const REQUEST_TIMEOUT_MS = 60_000;
const DISPOSE_STEP_MS = 2_000;

if (process.stdin.isTTY) throw new Error('this file is started by Riffet');

const writeOut = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);
const send = message => { writeOut(`${JSON.stringify(message)}\n`); };

let nextId = 1;
const pending = new Map();
const state = { pluginId: '', stateDir: '', settings: {}, secrets: {}, executables: {}, modelSourcesInUse: [], granted: [] };
let plugin;
let activation;
const flows = new Map();
/** The `signal` of each command running now. */
const running = new Set();

const describe = error => (error instanceof Error && error.message ? error.message : String(error));
const failure = error => ({
  message: describe(error),
  ...(error && typeof error.code === 'string' ? { code: error.code } : {}),
  ...(error && Number.isInteger(error.statusCode) ? { statusCode: error.statusCode } : {}),
});

/** A request to the server. It stops waiting after a while, so a plugin never hangs on a server that no longer answers. */
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, REQUEST_TIMEOUT_MS);
    timer.unref();
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    send({ id, method, params });
  });
}

const unsupported = what => Object.assign(new Error(`${what} is not available to an installed package`), { code: 'PLUGIN_HOST_UNSUPPORTED', statusCode: 501 });

// Pure helpers of the server's gateway module, copied because nothing outside the package is readable here.
const gatewayBaseUrl = (baseUrl, segment = '/v1') => {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = /\/v\d+$/.test(path) ? path : `${path}${segment}`;
  return url.toString().replace(/\/$/, '');
};
const gatewayRootUrl = baseUrl => {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v\d+$/, '');
  return url.toString().replace(/\/$/, '');
};
const effortOption = (levels, declaredDefault) => {
  const unique = [...new Set(levels.filter(level => typeof level === 'string' && level.trim()).map(level => level.trim()))];
  if (!unique.length) return undefined;
  return {
    id: 'effort', name: 'Reasoning effort', category: 'thought_level', type: 'select',
    currentValue: declaredDefault && unique.includes(declaredDefault) ? declaredDefault : unique[0],
    options: unique.map(level => ({ value: level, name: level })),
  };
};

const host = {
  logger: Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, message => process.stderr.write(String(message) + '\n')])),
  get id() { return state.pluginId; },
  stateDir: async () => state.stateDir,
  settings: () => state.settings,
  secrets: {
    get: name => state.secrets[name],
    async set(name, value) {
      await call('host.secrets.set', { name, value });
      if (value === null) delete state.secrets[name]; else state.secrets[name] = value;
    },
  },
  // `process.exec`: a command the package declared runs on the host, outside this sandbox, in the package's state directory
  // (`options.cwd` is accepted and ignored). The package never learns a host path: `resolveCli` answers with the name.
  runProcess: async (file, args, options = {}) => {
    if (typeof file !== 'string' || !Object.hasOwn(state.executables, file)) throw unsupported('runProcess');
    const { timeoutMs, maxOutputBytes, env } = options;
    return call('host.exec', { command: file, args, ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}), ...(env ? { env } : {}) });
  },
  resolveCli: name => (typeof name === 'string' && Object.hasOwn(state.executables, name) && state.executables[name] === true ? name : undefined),
  modelSourceInUse: id => state.modelSourcesInUse.includes(id),
  gateway: {
    fetchModels(request) {
      if (typeof request?.select === 'function') return Promise.reject(unsupported('gateway.fetchModels with select'));
      const { signal: _signal, select: _select, ...plain } = request ?? {};
      return call('host.gateway.fetchModels', { request: plain });
    },
    baseUrl: gatewayBaseUrl,
    rootUrl: gatewayRootUrl,
    effortOption,
  },
  invalidateModelCatalogs: () => { call('host.invalidateModelCatalogs').catch(() => undefined); },
  get tasks() {
    return state.granted.includes('tasks.run') ? { start: (projectId, actionId, params, options) => call('host.tasks.start', { projectId, actionId, ...(params ? { params } : {}), ...(options?.providerId ? { providerId: options.providerId } : {}), ...(options?.confirm ? { confirm: options.confirm } : {}) }) } : undefined;
  },
  error: (code, message, statusCode) => Object.assign(new Error(message), { code, ...(statusCode !== undefined ? { statusCode } : {}) }),
};

function projectOf({ handle, id, name }) {
  return {
    id, name,
    exists: path => call('project.exists', { handle, path }),
    readText: async (path, maxBytes) => (await call('project.readText', { handle, path, maxBytes })) ?? undefined,
    list: path => call('project.list', { handle, path }),
  };
}

const sourceOf = id => activation?.contributions.modelSources?.find(source => source.id === id);
const providerOf = id => {
  const provider = activation?.contributions.taskProviders?.find(item => item.id === id);
  if (!provider) throw new Error(`no task provider ${id}`);
  return provider;
};
const commandOf = id => {
  const commands = activation?.contributions.commands;
  const command = commands && Object.hasOwn(commands, id) ? commands[id] : undefined;
  if (!command || typeof command.run !== 'function') throw new Error(`no command ${id}`);
  return command;
};
const avatarStyleOf = id => {
  const styles = activation?.contributions.avatarStyles;
  const style = styles && Object.hasOwn(styles, id) ? styles[id] : undefined;
  if (!style || typeof style.generate !== 'function') throw new Error(`no avatar style ${id}`);
  return style;
};
const actionOf = id => {
  const actions = activation?.contributions.actions;
  const action = actions && Object.hasOwn(actions, id) ? actions[id] : undefined;
  if (!action) throw new Error(`no action ${id}`);
  return action;
};

async function bounded(run, ms) {
  let timer;
  try {
    await Promise.race([Promise.resolve().then(run), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`did not finish within ${ms / 1000}s`)), ms); })]);
  } finally { clearTimeout(timer); }
}

const handlers = {
  async load({ entry, pluginId, stateDir, settings, secrets, executables, modelSourcesInUse, granted }) {
    Object.assign(state, { pluginId, stateDir, settings, secrets, executables: executables ?? {}, modelSourcesInUse: modelSourcesInUse ?? [], granted: granted ?? [] });
    const exported = (await import(pathToFileURL(entry).href)).default;
    if (!exported || typeof exported.activate !== 'function') throw new Error('the server entry must export default { activate }');
    plugin = exported;
    return { protocol: 1 };
  },
  state({ settings, secrets, executables, modelSourcesInUse }) { Object.assign(state, { settings, secrets, executables: executables ?? {}, modelSourcesInUse: modelSourcesInUse ?? [] }); return null; },

  async activate({ generation }) {
    const controller = new AbortController();
    const disposers = [];
    const current = { controller, disposers, ended: false, contributions: {} };
    const scope = {
      generation, signal: controller.signal,
      onDispose(fn) {
        if (!current.ended) disposers.push(fn);
        else bounded(fn, DISPOSE_STEP_MS).catch(() => undefined);
      },
    };
    activation = current;
    const contributions = (await plugin.activate(host, scope)) ?? {};
    current.contributions = contributions;
    const unsupportedKinds = ['sharePublisher', 'runtimeHooks', 'agentBackends'].filter(key => contributions[key] !== undefined && !(Array.isArray(contributions[key]) && contributions[key].length === 0));
    return {
      modelSources: (contributions.modelSources ?? []).map(source => ({
        id: source.id, label: source.label,
        ...(source.role ? { role: source.role } : {}),
        ...(Array.isArray(source.protocols) ? { protocols: [...source.protocols] } : {}),
        ...(Array.isArray(source.backends) ? { backends: [...source.backends] } : {}),
        ...(source.defaultEndpoint ? { defaultEndpoint: source.defaultEndpoint } : {}),
        ...(source.overridable ? { overridable: [...source.overridable] } : {}),
        ...(source.loginAction ? { loginAction: source.loginAction } : {}),
        ...(source.hint ? { hint: { text: source.hint.text, ...(source.hint.command ? { command: source.hint.command } : {}) } } : {}),
        ...(typeof source.usage === 'function' ? { usage: true } : {}),
      })),
      taskProviders: (contributions.taskProviders ?? []).map(provider => ({ id: provider.id, diagnostics: typeof provider.diagnostics === 'function' })),
      actions: Object.entries(contributions.actions ?? {}).map(([id, action]) => ({ id, label: action.label, kind: action.kind })),
      commands: Object.keys(contributions.commands ?? {}),
      avatarStyles: Object.keys(contributions.avatarStyles ?? {}),
      status: typeof contributions.status === 'function',
      doctorChecks: typeof contributions.doctorChecks === 'function',
      page: typeof contributions.page?.read === 'function',
      unsupported: unsupportedKinds,
    };
  },

  async dispose() {
    const current = activation;
    if (!current) return { failures: [] };
    current.ended = true;
    current.controller.abort();
    for (const controller of running) controller.abort();
    const failures = [];
    for (const dispose of [...(typeof current.contributions.dispose === 'function' ? [() => current.contributions.dispose()] : []), ...[...current.disposers].reverse()]) {
      try { await bounded(dispose, DISPOSE_STEP_MS); } catch (error) { failures.push(describe(error)); }
    }
    current.disposers.length = 0;
    flows.clear();
    return { failures };
  },

  async 'action.run'({ id }) {
    const outcome = await actionOf(id).run();
    if (outcome?.kind !== 'device-flow') return outcome;
    const flow = `${nextId++}`;
    flows.set(flow, outcome);
    return { kind: 'device-flow', verificationUri: outcome.verificationUri, ...(outcome.userCode ? { userCode: outcome.userCode } : {}), intervalMs: outcome.intervalMs, expiresAt: outcome.expiresAt, flow };
  },
  async 'flow.poll'({ flow }) {
    const started = flows.get(flow);
    if (!started) throw new Error('this sign-in is no longer pending');
    const step = await started.poll();
    if (step.kind !== 'pending' && step.kind !== 'slow_down') flows.delete(flow);
    return step;
  },
  status() { return activation.contributions.status(); },
  doctorChecks() { return activation.contributions.doctorChecks(); },
  'page.read'({ locale }) { return activation.contributions.page.read({ locale }); },
  async 'page.run'({ locale, action, item }) {
    const page = activation.contributions.page;
    if (typeof page.run !== 'function') throw new Error('this page has no buttons');
    return (await page.run({ locale }, action, item)) ?? {};
  },

  'modelSource.catalog'({ id, backend, overrides }) {
    const source = sourceOf(id);
    if (!source) throw new Error(`no model source ${id}`);
    return source.catalog(backend, overrides);
  },
  async 'modelSource.prepare'({ id, overrides }) {
    const source = sourceOf(id);
    if (!source) throw new Error(`no model source ${id}`);
    await source.prepare?.(overrides);
    return JSON.parse(JSON.stringify(source.resolve(overrides) ?? {}));
  },
  'modelSource.usage'({ id, overrides }) {
    const source = sourceOf(id);
    if (!source || typeof source.usage !== 'function') throw new Error(`no usage provider for model source ${id}`);
    return source.usage(overrides);
  },

  'avatar.generate'({ id, request }) { return avatarStyleOf(id).generate(request); },

  async 'command.run'({ id, projectId, sessionId, args, message, selection, locale, timeoutMs }) {
    const command = commandOf(id);
    const controller = new AbortController();
    running.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    try {
      return await command.run({ ...(projectId ? { projectId } : {}), ...(sessionId ? { sessionId } : {}), args, ...(message ? { message } : {}), ...(selection ? { selection } : {}), ...(locale ? { locale } : {}), signal: controller.signal });
    } finally { clearTimeout(timer); running.delete(controller); }
  },

  'task.detect'({ provider, project }) { return providerOf(provider).detect(projectOf(project)); },
  'task.actions'({ provider, project }) { return providerOf(provider).actions(projectOf(project)); },
  'task.plan'({ provider, action, taskParams, project }) { return providerOf(provider).plan(action, taskParams, projectOf(project)); },
  async 'task.diagnostics'({ provider, logTail }) {
    const found = providerOf(provider);
    if (typeof found.diagnostics !== 'function') return [];
    return found.diagnostics(logTail, { relativize: path => path });
  },
};

async function receive(message) {
  if (!message || typeof message !== 'object' || typeof message.id !== 'number') return;
  if (typeof message.method !== 'string') {
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(Object.assign(new Error(message.error.message), message.error.code ? { code: message.error.code } : {}, message.error.statusCode ? { statusCode: message.error.statusCode } : {}));
    else waiting.resolve(message.result ?? null);
    return;
  }
  const handler = Object.hasOwn(handlers, message.method) ? handlers[message.method] : undefined;
  try {
    if (!handler) throw new Error(`unknown method ${message.method}`);
    const result = await handler(message.params ?? {});
    send({ id: message.id, result: result ?? null });
  } catch (error) {
    send({ id: message.id, error: failure(error) });
  }
}

let partial = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  const lines = chunk.split('\n');
  lines[0] = partial + lines[0];
  partial = lines.pop();
  for (const line of lines) if (line) void receive(JSON.parse(line));
});
// The server is gone or closed stdin: nothing is left to serve.
process.stdin.on('end', () => process.exit(0));
