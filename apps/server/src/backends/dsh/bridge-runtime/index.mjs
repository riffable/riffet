import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'

export const name = 'riffet-dsh-native-bridge'
export const inject = [
  'agents', 'sessionQuery', 'llm', 'attachments', 'agentDefaultModel', 'approval',
]

const MAX_FRAME_BYTES = 64 * 1024 * 1024
const PROTOCOL_VERSION = 1
const handles = new Map()
const openings = new Map()
const inFlightBySession = new Map()
let socket
let runtimeContext
let nextRequestId = 0
const hostRequests = new Map()
/**
 * DSH's session-projection registry, when this profile mounts one. It is *not* in `inject`: the
 * registry only feeds the workbench's context popover, and a profile without it must still load
 * this bridge (the conversation itself does not depend on the meter).
 */
let projections
/**
 * DSH's permission-preset service (`@deepseek-ai/dsh-base` mounts it). Optional for the same reason:
 * without it a profile can only express the bare approval policy, and the bridge falls back to that.
 */
let permissionPresets
/** DSH's skill registry (`@deepseek-ai/dsh-skill`). Optional: without it the `/` menu lists no skills. */
let skills
/** DSH's background-job registry (`@deepseek-ai/dsh-jobs`). Optional: without it there is nothing to report or stop. */
let jobs
/** Cold folds of idle sessions' composition, keyed by native id, valid while the stored log's length holds. */
const coldBreakdowns = new Map()
/** The session each child session (a subagent, at any depth) was started from, by child id. */
const parents = new Map()
const PARENT_LIMIT = 4096
/** `delegationDepth` DSH allows is far below this; it only bounds a malformed chain. */
const CHILD_DEPTH = 16

function asRecord(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  return value
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`)
  return value
}

function canonicalCwd(value) {
  const cwd = requiredString(value, 'cwd')
  if (!isAbsolute(cwd)) throw new TypeError('cwd must be an absolute workspace path')
  return resolve(cwd)
}

function assertEntryScope(entry, sessionId, cwd) {
  if (entry.workbenchSessionId !== requiredString(sessionId, 'sessionId')) {
    throw new Error('DeepSeek Harness session belongs to another workbench conversation')
  }
  if (entry.cwd !== canonicalCwd(cwd)) {
    throw new Error('DeepSeek Harness session belongs to another workspace')
  }
}

function assertPersistedScope(snapshot, nativeSessionId, cwd) {
  if (String(snapshot.session?.id ?? '') !== nativeSessionId) {
    throw new Error('DeepSeek Harness history id does not match the requested native session')
  }
  if (typeof snapshot.session?.cwd !== 'string' || resolve(snapshot.session.cwd) !== canonicalCwd(cwd)) {
    throw new Error('DeepSeek Harness session belongs to another or unknown workspace')
  }
}

function sendMessage(message) {
  if (!socket || socket.destroyed) throw new Error('workbench DSH bridge is disconnected')
  socket.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

function notify(method, params) {
  try { sendMessage({ method, params }) } catch { /* process teardown owns disconnects */ }
}

function callHost(method, params) {
  const id = `dsh-${++nextRequestId}`
  const requestId = params?.interaction?.requestId
  const promise = new Promise((resolve, reject) => hostRequests.set(id, { resolve, reject, requestId }))
  sendMessage({ id, method, params })
  return promise
}

function receiveMessage(value) {
  const message = asRecord(value, 'JSON-RPC message')
  if (message.jsonrpc !== '2.0') throw new TypeError('unsupported bridge JSON-RPC version')
  if (typeof message.method === 'string') {
    void dispatchRequest(message)
    return
  }
  const pending = hostRequests.get(String(message.id))
  if (!pending) return
  hostRequests.delete(String(message.id))
  if (message.error && typeof message.error === 'object') {
    pending.reject(new Error(typeof message.error.message === 'string' ? message.error.message : 'workbench DSH bridge request failed'))
  } else {
    pending.resolve(message.result)
  }
}

async function dispatchRequest(message) {
  const id = message.id
  try {
    const params = asRecord(message.params ?? {}, 'JSON-RPC params')
    if (message.method === 'interaction/cancel') {
      cancelHostInteraction(params)
      if (id !== undefined) sendMessage({ id, result: { accepted: true } })
      return
    }
    const result = await dispatchCall(message.method, params)
    if (id !== undefined) sendMessage({ id, result })
  } catch (error) {
    if (id !== undefined) {
      sendMessage({ id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } })
    }
  }
}

async function dispatchCall(method, params) {
  switch (method) {
    case 'bridge/ready':
      return { protocolVersion: PROTOCOL_VERSION, profileName: params.profileName }
    case 'runtime/models':
      return await listModels()
    case 'runtime/skills':
      return await listSkills(params)
    case 'extensions/list': {
      const manager = runtimeContext.get('pluginManager')
      if (!manager) return { bundles: [], plugins: [], available: false }
      return { bundles: await manager.listBundles(), plugins: await manager.listPlugins(), available: true }
    }
    case 'extensions/manage': {
      const manager = runtimeContext.get('pluginManager')
      if (!manager) throw new Error('This DSH composition has no plugin manager')
      const target = requiredString(params.target, 'target')
      const versionAt = target.indexOf('@', target.startsWith('@') ? 1 : 0)
      const packageName = versionAt < 0 ? target : target.slice(0, versionAt)
      if (['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-experimental-auto-review', '@riffet/dsh-native-bridge'].includes(packageName)) throw new Error('Riffet requires this bundle')
      if (params.action === 'install') return await manager.installBundle(target)
      const bundle = (await manager.listBundles()).find(value => value.name === target)
      if (!bundle || bundle.readOnlyReason) throw new Error('Bundle is unknown or managed')
      if (params.action === 'uninstall') {
        if (!bundle.removable) throw new Error('This bundle cannot be removed')
        return await manager.removeBundle(target)
      }
      if (params.action === 'enable' || params.action === 'disable') return await manager.setBundleEnabled(target, params.action === 'enable')
      throw new Error('Unsupported extension operation')
    }
    case 'session/read':
      return await readSession(params)
    case 'session/validate-content':
      return await validatePromptContent(params)
    case 'session/open':
      return await openSession(params)
    case 'session/send':
      return await sendPrompt(params)
    case 'session/interrupt':
      return interruptSession(params)
    case 'session/configure':
      return configureSession(params)
    case 'session/dispose':
      return await disposeSession(params)
    case 'job/kill':
      return killJob(params)
    case 'runtime/shutdown':
      return await shutdown()
    default:
      throw new Error(`unknown DSH bridge method ${String(method)}`)
  }
}

/**
 * The skills a user may invoke in `cwd`. DSH's own pre-step loads one whenever a user message
 * names it as a whitespace-bounded `/name`, anywhere in the text, so listing is all this needs.
 */
async function listSkills(params) {
  if (!skills) return { skills: [] }
  const listed = await skills.list({ cwd: canonicalCwd(params.cwd) })
  return {
    skills: listed
      .filter(skill => skill.invocation?.userInvocable !== false)
      .map(skill => ({ name: skill.name, description: skill.description, ...(skill.path ? { path: skill.path } : {}) })),
  }
}

async function withSessionLock(sessionId, operation) {
  const previous = inFlightBySession.get(sessionId) ?? Promise.resolve()
  let release
  const current = new Promise(resolve => { release = resolve })
  inFlightBySession.set(sessionId, current)
  await previous
  try { return await operation() } finally {
    release()
    if (inFlightBySession.get(sessionId) === current) inFlightBySession.delete(sessionId)
  }
}

function sessionKey(nativeSessionId) { return String(nativeSessionId) }

/**
 * Name the harness object behind every image block of one session event.
 *
 * An image a tool produced is a durable attachment reference, whose bytes live in the harness's own
 * store and nowhere the workbench can read by path. The store is only in reach here, so the object's
 * host path is resolved while the event is in hand and travels beside the block as `hostPath`; the
 * workbench then renders the picture instead of a placeholder. Events without image blocks — and
 * blocks whose reference the store refuses — pass through untouched.
 */
function withImagePaths(event) {
  const message = event?.data?.message
  const blocks = message?.content
  if (!Array.isArray(blocks)) return event
  let resolved = false
  const annotated = blocks.map((block) => {
    if (!block || block.type !== 'image' || typeof block.hostPath === 'string') return block
    const attachment = block.attachment
    if (!attachment || typeof attachment.attachmentId !== 'string' || typeof attachment.mediaType !== 'string') return block
    let hostPath
    try { hostPath = runtimeContext?.attachments?.imageHostPath(attachment) } catch { hostPath = undefined }
    if (typeof hostPath !== 'string' || hostPath.length === 0) return block
    resolved = true
    return { ...block, hostPath }
  })
  if (!resolved) return event
  return { ...event, data: { ...event.data, message: { ...message, content: annotated } } }
}

function promptExists(agent, commandId) {
  const matches = message => message?.source?.kind === 'user' && message.source.rpcId === commandId
  if (agent.inbox.nextTurn.some(matches) || agent.inbox.nextStep.some(matches)) return true
  return agent.session.snapshotEvents().some(event => event.type === 'user/message' && matches(event.data))
}

function modelSelection(params, fallback) {
  const source = params.selection && typeof params.selection === 'object' ? params.selection : fallback
  if (!source || typeof source.provider !== 'string' || typeof source.model !== 'string') {
    throw new TypeError('a provider and model are required to open a DSH session')
  }
  return {
    provider: source.provider,
    model: source.model,
    ...(typeof source.reasoningEffort === 'string' ? { reasoningEffort: source.reasoningEffort } : {}),
  }
}

function durableSelection(snapshot, fallback) {
  const events = snapshot?.events ?? []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'model/selection') continue
    const data = event.data
    if (typeof data?.provider === 'string' && typeof data?.model === 'string') {
      return { provider: data.provider, model: data.model, ...(typeof data.reasoningEffort === 'string' ? { reasoningEffort: data.reasoningEffort } : {}) }
    }
  }
  return fallback
}

function durableApproval(snapshot) {
  const events = snapshot?.events ?? []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type === 'approval/policy' && (event.data?.policy === 'ask' || event.data?.policy === 'never')) return event.data.policy
  }
  return undefined
}

async function findPersisted(nativeSessionId) {
  try {
    return await runtimeContext.sessionQuery.readSession(SessionId(nativeSessionId))
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return undefined
    throw error
  }
}

async function openSession(params) {
  const nativeSessionId = requiredString(params.nativeSessionId, 'nativeSessionId')
  const workbenchSessionId = requiredString(params.sessionId, 'sessionId')
  const cwd = canonicalCwd(params.cwd)
  return await withSessionLock(nativeSessionId, async () => {
    const existing = handles.get(nativeSessionId)
    if (existing) {
      assertEntryScope(existing, workbenchSessionId, cwd)
      await applySessionConfig(existing, params)
      announceJobs(existing)
      return describeAgent(existing)
    }
    const opening = openings.get(nativeSessionId)
    if (opening) {
      const result = await opening
      const opened = handles.get(nativeSessionId)
      if (opened) assertEntryScope(opened, workbenchSessionId, cwd)
      return result
    }
    const task = (async () => {
      const persisted = await findPersisted(nativeSessionId)
      if (persisted) assertPersistedScope(persisted, nativeSessionId, cwd)
      const fallback = modelSelection(params, runtimeContext.agentDefaultModel.currentSelection())
      const selected = durableSelection(persisted, fallback)
      const sessionId = SessionId(nativeSessionId)
      const agentOptions = selected
      const handle = persisted
        ? await runtimeContext.agents.resume({ resumeSessionId: sessionId, agentOptions })
        : await runtimeContext.agents.create({ sessionId, meta: { cwd: requiredString(params.cwd, 'cwd') }, agentOptions })
      const selection = { current: selected, assembled: undefined }
      installModelSelection(handle.agent.ctx, selection)
      if (!persisted || !persisted.events.some(event => event.type === 'model/selection')) {
        handle.agent.session.append('model/selection', selected)
      }
      applyPermission(handle.agent, params, durableApproval(persisted) !== undefined)
      const entry = { handle, agent: handle.agent, selection, nativeSessionId, workbenchSessionId, cwd, commandRuns: new Map(), turnRuns: new Map(), activeTurn: undefined, streamedSeqs: new Set() }
      for (const event of persisted?.events ?? []) noteChildren(nativeSessionId, undefined, event)
      handles.set(nativeSessionId, entry)
      notify('agent/status', { nativeSessionId, status: entry.agent.status })
      announceJobs(entry)
      return describeAgent(entry)
    })()
    openings.set(nativeSessionId, task)
    try { return await task } finally { if (openings.get(nativeSessionId) === task) openings.delete(nativeSessionId) }
  })
}

/** What the workbench needs of a job; the output ring stays in DSH. */
function jobWire(job) {
  return {
    id: String(job.id),
    kind: String(job.kind),
    label: String(job.label ?? '').slice(0, 4096),
    status: job.status,
    ...(typeof job.progress === 'string' ? { progress: job.progress.slice(0, 1024) } : {}),
    ...(typeof job.detail === 'string' ? { detail: job.detail.slice(0, 2048) } : {}),
    startedAt: job.startedAt,
    ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
  }
}

/** Lifecycle events of the jobs a handled session owns. Output chunks are not forwarded. */
function onJobEvent(event) {
  if (event.type === 'output' || !event.job) return
  const owner = event.job.owner === undefined ? undefined : String(event.job.owner)
  const entry = owner === undefined ? undefined : handles.get(owner)
  if (!entry) return
  notify('job/event', {
    nativeSessionId: entry.nativeSessionId,
    sessionId: entry.workbenchSessionId,
    type: event.type,
    ...(event.cause ? { cause: event.cause } : {}),
    job: jobWire(event.job),
  })
}

/** A session opened after its jobs started (a reconnect) learns about the ones still running. */
function announceJobs(entry) {
  if (!jobs) return
  try {
    for (const job of jobs.list(SessionId(entry.nativeSessionId))) {
      if (job.status === 'running' || job.status === 'stopping') {
        notify('job/event', { nativeSessionId: entry.nativeSessionId, sessionId: entry.workbenchSessionId, type: 'registered', job: jobWire(job) })
      }
    }
  } catch { /* the registry may not serve this owner */ }
}

/** `jobs.kill` is a request; the settlement that follows is the evidence. */
function killJob(params) {
  const nativeSessionId = requiredString(params.nativeSessionId, 'nativeSessionId')
  const entry = handles.get(nativeSessionId)
  if (!entry) throw new Error('session is not open')
  if (params.sessionId !== entry.workbenchSessionId) throw new Error('job does not belong to this workbench session')
  if (!jobs) throw new Error('this DeepSeek Harness composition has no background jobs')
  const owner = SessionId(nativeSessionId)
  const jobId = requiredString(params.jobId, 'jobId')
  const result = jobs.kill(jobId, owner, typeof params.reason === 'string' ? params.reason.slice(0, 200) : undefined)
  return { result, job: jobWire(jobs.get(jobId, owner)) }
}

function describeAgent(entry) {
  const selected = entry.selection.current
  const policy = durableApproval({ events: entry.agent.session.snapshotEvents() }) ?? 'ask'
  return {
    nativeSessionId: entry.nativeSessionId,
    status: entry.agent.status === 'running' ? 'busy' : 'idle',
    model: selected?.model,
    provider: selected?.provider,
    reasoningEffort: selected?.reasoningEffort,
    approval: policy,
    ...(currentPermission(entry.agent.session) ? { permission: currentPermission(entry.agent.session) } : {}),
  }
}

/** The session's preset as DSH derives it; none for `custom`, which no client can select back. */
function currentPermission(session) {
  if (!permissionPresets) return undefined
  const current = permissionPresets.current(session)
  return current === 'custom' ? undefined : current
}

/**
 * Switch to the requested preset through the preset service's own writer (the one DSH's webhook
 * sessions use): it records the preset and moves the sandbox mode and approval policy together, and
 * an unknown or unadmitted preset throws before anything is written. Without the service only the
 * bare policy can be applied — announced to the model when it replaces a logged one.
 */
function applyPermission(agent, params, announce = true) {
  if (permissionPresets && typeof params.permission === 'string' && params.permission) {
    permissionPresets.set(agent.session, params.permission)
    return
  }
  if (params.approval !== 'ask' && params.approval !== 'never') return
  const current = durableApproval({ events: agent.session.snapshotEvents() }) ?? 'ask'
  if (current === params.approval) return
  if (announce) runtimeContext.approval.setPolicy(agent, params.approval)
  else setApprovalPolicy(agent.session, params.approval)
}

async function applySessionConfig(entry, params) {
  applyPermission(entry.agent, params)
  applyModelSelection(entry, params)
}

function applyModelSelection(entry, params) {
  if (params.modelSelection && typeof params.modelSelection === 'object') {
    const selected = modelSelection({ selection: params.modelSelection }, entry.selection.current)
    if (selected.provider !== entry.selection.current?.provider
      || selected.model !== entry.selection.current?.model
      || selected.reasoningEffort !== entry.selection.current?.reasoningEffort) {
      entry.agent.session.append('model/selection', selected)
      entry.selection.current = selected
    }
  }
}

async function admitContent(parts) {
  if (!Array.isArray(parts)) throw new TypeError('content must be an array')
  const admission = []
  for (const partValue of parts) {
    const part = asRecord(partValue, 'content part')
    if (part.type === 'text') {
      if (typeof part.text !== 'string') throw new TypeError('text must be a string')
      admission.push({ type: 'text', text: part.text })
    } else if (part.type === 'image') {
      const data = requiredString(part.data, 'image data')
      admission.push({ type: 'image', data, mediaType: requiredString(part.mediaType, 'image mediaType'), ...(typeof part.name === 'string' ? { name: part.name } : {}) })
    } else if (part.type === 'file') {
      const data = requiredString(part.data, 'file data')
      const attachment = await runtimeContext.attachments.admitEncodedFile({ data, ...(typeof part.name === 'string' ? { name: part.name } : {}) })
      admission.push({ type: 'file', attachment })
    } else {
      throw new TypeError(`unsupported prompt content type ${String(part.type)}`)
    }
  }
  return await runtimeContext.attachments.admitPromptContent(admission)
}

async function validatePromptContent(params) {
  if (!Array.isArray(params.content)) throw new TypeError('content must be an array')
  const images = params.content.filter(part => part && part.type === 'image')
  const limits = runtimeContext.attachments.imageLimits
  const totalBytes = images.reduce((sum, image) => sum + Buffer.from(requiredString(image.data, 'image data'), 'base64').byteLength, 0)
  if (images.length > limits.maxImagesPerMessage) throw new Error(`Image batch exceeds the configured limit of ${limits.maxImagesPerMessage} images.`)
  if (totalBytes > limits.maxMessageImageBytes) throw new Error('Image batch exceeds the configured aggregate image-byte limit.')
  for (const image of images) {
    const data = Buffer.from(requiredString(image.data, 'image data'), 'base64')
    const mediaType = requiredString(image.mediaType, 'image mediaType')
    if (data.byteLength > limits.maxImageBytes) throw new Error(`Image exceeds the configured ${limits.maxImageBytes}-byte limit.`)
    if (!limits.mediaTypes.includes(mediaType)) throw new Error(`Image type ${mediaType} is not accepted by this DSH deployment.`)
    if (data.toString('base64') !== image.data) throw new Error('Image data must use canonical base64 encoding.')
    await runtimeContext.attachments.validateImage({ data, mediaType, ...(typeof image.name === 'string' ? { name: image.name } : {}) })
  }
  return { accepted: true, imageCount: images.length, imageBytes: totalBytes }
}

async function sendPrompt(params) {
  const nativeSessionId = requiredString(params.nativeSessionId, 'nativeSessionId')
  return await withSessionLock(nativeSessionId, async () => {
    const entry = handles.get(nativeSessionId)
    if (!entry) throw new Error(`DSH session ${nativeSessionId} is not open`)
    assertEntryScope(entry, params.sessionId, params.cwd)
    const commandId = requiredString(params.commandId, 'commandId')
    const runId = requiredString(params.runId, 'runId')
    if (entry.commandRuns.has(commandId) || promptExists(entry.agent, commandId)) return { accepted: true, duplicate: true }
    await applySessionConfig(entry, params.config ?? {})
    const content = await admitContent(params.content)
    const message = createUserMessage({ content, source: { kind: 'user', rpcId: commandId } })
    entry.commandRuns.set(commandId, { runId, attachments: Array.isArray(params.attachments) ? params.attachments : [] })
    if (entry.commandRuns.size > 2048) entry.commandRuns.delete(entry.commandRuns.keys().next().value)
    try {
      entry.agent.followup(message)
    } catch (error) {
      entry.commandRuns.delete(commandId)
      throw error
    }
    return { accepted: true, messageId: message.id }
  })
}

async function interruptSession(params) {
  const nativeSessionId = requiredString(params.nativeSessionId, 'nativeSessionId')
  const entry = handles.get(nativeSessionId)
  if (!entry) return { interrupted: false }
  assertEntryScope(entry, params.sessionId, params.cwd)
  // Interrupts cancel the active turn's pending inbox work too: Riffet keeps queued (not yet sent)
  // runs in its own dispatch queue, so preserving DSH's inbox would resurrect cancelled messages.
  entry.agent.cancel({ kind: 'user' }, { keepInbox: false })
  // cancel() only signals the active activity. Do not acknowledge stop until the
  // agent has fully quiesced; an already idle agent confirms the same boundary.
  // The host releases the workspace queue on this RPC.
  await entry.agent.whenIdle()
  return { interrupted: true }
}

async function configureSession(params) {
  const nativeSessionId = requiredString(params.nativeSessionId, 'nativeSessionId')
  const entry = handles.get(nativeSessionId)
  if (!entry) return { configured: false }
  assertEntryScope(entry, params.sessionId, params.cwd)
  const refusal = await refuseUnservableSelection(params.modelSelection)
  if (refusal) return refusal
  // The permission goes first: a preset this profile does not offer, or Auto refused by its
  // admission check, is refused here before the model selection is written.
  try { applyPermission(entry.agent, params) } catch (error) {
    return { configured: false, reason: 'permission-unavailable', message: error instanceof Error ? error.message : String(error) }
  }
  applyModelSelection(entry, params)
  return { configured: true, ...describeAgent(entry) }
}

/**
 * Validate a requested model selection the way DSH's own session controller validates one before it
 * installs it: `llm.resolveCallConfig`, which rejects an unregistered provider, a route its adapter
 * refuses, or a reasoning effort the model does not offer. The controller also runs `requireModel`
 * (exact membership in `llm.listModels`) first; that half is deliberately not repeated here, because
 * a workbench picker offers the *gateway's* catalogue (`mergeDshModelListing`) while this profile's
 * own list only names the ids it was configured with — an exact-membership gate would refuse models
 * the gateway serves. A model neither side can serve therefore fails at its first turn instead.
 *
 * The server matches this reason (`MODEL_UNAVAILABLE` in `runtime.ts`); the selection itself is
 * installed in the client's own spelling, because that is what the picker round-trips.
 *
 * @param {unknown} modelSelection - the requested selection, when the change names one.
 * @returns {Promise<{configured: false, reason: string, message: string} | undefined>} the refusal.
 */
async function refuseUnservableSelection(modelSelection) {
  if (!modelSelection || typeof modelSelection !== 'object') return undefined
  try {
    await runtimeContext.llm.resolveCallConfig({
      provider: requiredString(modelSelection.provider, 'provider'),
      model: requiredString(modelSelection.model, 'model'),
      ...(typeof modelSelection.reasoningEffort === 'string' ? { reasoningEffort: modelSelection.reasoningEffort } : {}),
    })
    return undefined
  } catch (error) {
    return { configured: false, reason: 'model-unavailable', message: error instanceof Error ? error.message : String(error) }
  }
}

async function disposeSession(params) {
  const nativeSessionId = requiredString(params.nativeSessionId, 'nativeSessionId')
  const entry = handles.get(nativeSessionId)
  if (!entry) return { disposed: false }
  assertEntryScope(entry, params.sessionId, params.cwd)
  handles.delete(nativeSessionId)
  await entry.handle.dispose()
  notify('agent/status', { nativeSessionId, status: 'disposed' })
  return { disposed: true }
}

/**
 * What the next request is made of, as DSH itself folds it: the surviving system prompt, the latest
 * request envelope's tool schemas, and everything else on the surface.
 *
 * The token meter prices all three with its fixed density estimate, so they are a composition —
 * they deliberately do not sum to the provider-reported prompt tokens the workbench shows beside
 * them (see `contextBreakdownProjectionDefinition`). A live session is projected off its in-memory
 * log; an idle one (never opened in this DSH process) is folded cold over the stored log the read
 * already holds, and remembered until that log grows, because the workbench polls this read.
 */
function contextBreakdown(live, nativeSessionId, snapshot) {
  if (!projections) return undefined
  try {
    if (live) return breakdownCounts(projections.snapshot(live.agent.session, ['contextBreakdown'])?.values?.contextBreakdown)
    const total = snapshot.events.length
    const cached = coldBreakdowns.get(nativeSessionId)
    if (cached && cached.total === total) return cached.value
    const restored = projections.restore({}, snapshot.events, 0, snapshot.session, snapshot.inheritedEventCount ?? 0)
    const value = breakdownCounts(restored.snapshot?.values?.contextBreakdown)
    coldBreakdowns.set(nativeSessionId, { total, value })
    return value
  } catch {
    // A unit that refuses to fold must not take the transcript's read path down with it.
    return undefined
  }
}

function breakdownCounts(value) {
  if (!value) return undefined
  const counts = [value.systemTokens, value.toolsTokens, value.messageTokens]
  if (!counts.every(count => typeof count === 'number' && Number.isFinite(count) && count >= 0)) return undefined
  return { systemTokens: Math.round(counts[0]), toolsTokens: Math.round(counts[1]), messageTokens: Math.round(counts[2]) }
}

async function readSession(params) {
  const nativeSessionId = requiredString(params.nativeSessionId, 'nativeSessionId')
  const sessionId = requiredString(params.sessionId, 'sessionId')
  const cwd = canonicalCwd(params.cwd)
  const live = handles.get(nativeSessionId)
  if (live) assertEntryScope(live, sessionId, cwd)
  const snapshot = await findPersisted(nativeSessionId)
  if (!snapshot) return { found: false, nativeSessionId, events: [], before: 0, total: 0, hasMore: false }
  assertPersistedScope(snapshot, nativeSessionId, cwd)
  const events = snapshot.events
  const total = events.length
  const requestedBefore = Number.isSafeInteger(params.before) && params.before >= 0 ? Math.min(params.before, total) : total
  const limit = Number.isSafeInteger(params.limit) && params.limit > 0 ? Math.min(params.limit, 8000) : 8000
  // `after`: the caller already holds every record before it, so only newer ones are returned.
  const after = Number.isSafeInteger(params.after) && params.after >= 0 ? Math.min(params.after, requestedBefore) : 0
  const start = Math.max(after, requestedBefore - limit)
  const slice = events.slice(start, requestedBefore).map(withImagePaths)
  const agent = handles.get(nativeSessionId)
  const breakdown = contextBreakdown(live, nativeSessionId, snapshot)
  return {
    found: true,
    nativeSessionId,
    session: snapshot.session,
    events: slice,
    start,
    before: requestedBefore,
    total,
    hasMore: start > 0,
    status: agent ? describeAgent(agent) : { status: 'idle', approval: durableApproval(snapshot) ?? 'ask' },
    ...(breakdown ? { contextBreakdown: breakdown } : {}),
  }
}

async function listModels() {
  const providers = runtimeContext.llm.listProviders()
  const models = []
  for (const provider of providers) {
    let listed
    try { listed = await runtimeContext.llm.listModels(provider.id) } catch { continue }
    for (const model of listed) {
      let resolved
      try { resolved = await runtimeContext.llm.resolveModelInfo(provider.id, model.id) } catch { resolved = undefined }
      models.push({
        provider: provider.id,
        providerName: provider.name,
        id: model.id,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
        ...(resolved?.reasoning ? { reasoning: resolved.reasoning } : {}),
      })
    }
  }
  return { models }
}

function describeSessionEvent(entry, session, event) {
  const nativeSessionId = String(session.id)
  if (Number.isSafeInteger(event.seq) && event.seq >= 0) entry.latestSequence = Math.max(entry.latestSequence ?? 0, event.seq)
  if (event.type === 'turn/start') entry.activeTurn = event.data.turn
  const commandId = event.type === 'user/message' && event.data?.source?.kind === 'user'
    ? event.data.source.rpcId
    : undefined
  if (typeof commandId === 'string' && Number.isSafeInteger(entry.activeTurn)) {
    const run = entry.commandRuns.get(commandId)
    if (run) {
      const commands = entry.turnRuns.get(entry.activeTurn) ?? []
      if (!commands.some(item => item.commandId === commandId)) entry.turnRuns.set(entry.activeTurn, [...commands, { commandId, ...run }])
    }
  }
  const turn = event.data?.turn ?? entry.activeTurn
  const turnCommands = Number.isSafeInteger(turn) ? entry.turnRuns.get(turn) : undefined
  const turnCommand = turnCommands?.at(-1)
  const run = typeof commandId === 'string' ? entry.commandRuns.get(commandId) : undefined
  const runId = run?.runId ?? turnCommand?.runId
  const eventCommandId = typeof commandId === 'string' ? commandId : event.type === 'turn/end' ? turnCommand?.commandId : undefined
  const attachments = run?.attachments ?? (event.type === 'turn/end' ? turnCommand?.attachments : undefined)
  const wire = { nativeSessionId, sessionId: entry.workbenchSessionId, event: withImagePaths(event), ...(runId ? { runId } : {}), ...(typeof eventCommandId === 'string' ? { commandId: eventCommandId } : {}), ...(attachments?.length ? { attachments } : {}) }
  notify('session/event', wire)
  if (event.type === 'turn/end') {
    entry.turnRuns.delete(event.data.turn)
    if (entry.activeTurn === event.data.turn) entry.activeTurn = undefined
    for (const command of turnCommands ?? []) {
      entry.commandRuns.delete(command.commandId)
    }
  }
}

function noteParent(childId, parentId) {
  if (typeof childId !== 'string' || !childId || childId === parentId) return
  parents.delete(childId)
  parents.set(childId, parentId)
  if (parents.size > PARENT_LIMIT) parents.delete(parents.keys().next().value)
}

/** What a session's record and header say about whose child it is, and which children it started. */
function noteChildren(id, session, event) {
  const parent = session?.header?.parentSession
  if (typeof parent === 'string' && parent) noteParent(id, parent)
  if (event?.type === 'subagent/catalog') noteParent(event.data?.childId, id)
}

/**
 * A session no host handle follows changed. If it descends from one that is handled, the host hears
 * `session/changed` for that one: its transcript reader reads the child's log, which no other
 * notification announces. Hosts that predate it ignore the method.
 */
function noteUnhandledEvent(session, event) {
  const id = String(session.id)
  noteChildren(id, session, event)
  let at = parents.get(id)
  for (let depth = 0; at !== undefined && depth < CHILD_DEPTH; depth += 1) {
    const root = handles.get(at)
    if (root) {
      notify('session/changed', { nativeSessionId: root.nativeSessionId, sessionId: root.workbenchSessionId, childSessionId: id })
      return
    }
    at = parents.get(at)
  }
}

function mapAgent(entry, message) {
  const nativeSessionId = entry.nativeSessionId
  const params = { nativeSessionId, sessionId: entry.workbenchSessionId, ...message }
  // An assistant-stream frame is not a status update: sending it as `agent/status` made the
  // workbench drop every delta on the floor and left live text to arrive with the committed
  // history instead. The two carry different payloads and now travel under different methods.
  notify(message.assistantStream ? 'agent/assistant-stream' : 'agent/status', params)
}

function interactionForPermission(entry, request) {
  const requestId = `approval:${randomUUID()}`
  const interactionId = `${entry.nativeSessionId}:${requestId}`
  const req = {
    interaction: {
      id: interactionId,
      revision: '1',
      transport: 'protocol',
      requestId,
      request: { toolName: request.toolName, ...(request.callId ? { callId: request.callId } : {}), ...(request.reason ? { reason: request.reason } : {}) },
      kind: 'permission',
      title: `Allow ${request.toolName}?`,
      ...(request.reason ? { message: request.reason } : {}),
      options: [],
      actions: [
        { id: 'allow-once', label: 'Allow once', tone: 'primary' },
        { id: 'reject', label: 'Reject', tone: 'danger' },
        { id: 'cancel', label: 'Cancel' },
      ],
    },
    signal: request.signal,
    requestId,
  }
  return req
}

function interactionForQuestion(entry, request, question, index) {
  const requestId = `question:${randomUUID()}`
  const options = Array.isArray(question.options) ? question.options : []
  return {
    requestId,
    signal: request.signal,
    interaction: {
      id: `${entry.nativeSessionId}:${request.wait?.callId ?? requestId}`,
      revision: String(index + 1),
      transport: 'protocol',
      requestId,
      // 1-based, like every other backend's question counter (the clients render `index / count`).
      request: { question, questionIndex: index + 1, questionCount: request.questions.length, ...(request.wait ? { wait: request.wait } : {}) },
      kind: question.intent?.kind === 'plan-review' ? 'plan' : 'question',
      title: question.header ?? `Question ${index + 1}`,
      message: question.detail ? `${question.question}\n\n${question.detail}` : question.question,
      options: options.map((option, optionIndex) => ({ id: `option:${optionIndex}`, label: option.label, selected: false })),
      multiple: question.multiSelect === true,
      allowOther: options.length === 0,
      questionIndex: index + 1,
      questionCount: request.questions.length,
      actions: [
        { id: 'submit', label: index + 1 < request.questions.length ? 'Next' : 'Submit', tone: 'primary' },
        { id: 'cancel', label: 'Cancel', tone: 'danger' },
      ],
    },
  }
}

async function askHost(entry, request) {
  let abortHandler
  const onAbort = request.signal
    ? new Promise(resolve => {
      abortHandler = () => resolve({ action: 'cancel' })
      if (request.signal.aborted) abortHandler()
      else request.signal.addEventListener('abort', abortHandler, { once: true })
    })
    : new Promise(() => {})
  try {
    const response = await Promise.race([callHost('interaction/open', { nativeSessionId: entry.nativeSessionId, sessionId: entry.workbenchSessionId, interaction: request.interaction }), onAbort])
    if (request.signal?.aborted) return { action: 'cancel' }
    return response
  } catch (error) {
    if (request.signal?.aborted) return { action: 'cancel' }
    throw error
  } finally {
    if (abortHandler) request.signal.removeEventListener('abort', abortHandler)
    if (request.signal?.aborted) notify('interaction/cancel', { nativeSessionId: entry.nativeSessionId, sessionId: entry.workbenchSessionId, requestId: request.requestId })
  }
}

function cancelHostInteraction(params) {
  const requestId = String(params.requestId ?? '')
  const found = [...hostRequests].find(([, request]) => request.requestId === requestId)
  if (!found) return false
  const [rpcId, request] = found
  request.reject(new Error('interaction request cancelled'))
  hostRequests.delete(rpcId)
  return true
}

async function askPermission(request) {
  const agent = request.agent
  const entry = handles.get(String(agent.id))
  if (!entry) return 'unavailable'
  if (request.signal?.aborted) return 'cancelled'
  const pending = interactionForPermission(entry, request)
  let response
  try { response = await askHost(entry, pending) } catch { return request.signal?.aborted ? 'cancelled' : 'unavailable' }
  if (response?.action === 'allow-once') return 'allowed-once'
  if (response?.action === 'reject') return 'rejected'
  if (response?.action === 'cancel' || request.signal?.aborted) return 'cancelled'
  return 'unavailable'
}

function selectedQuestionAnswer(question, response) {
  if (response?.action !== 'submit') return undefined
  const selectedIds = new Set(Array.isArray(response.selectedIds) ? response.selectedIds : [])
  const selected = (Array.isArray(question.options) ? question.options : [])
    .flatMap((option, index) => selectedIds.has(`option:${index}`) ? [option.label] : [])
  return { id: question.id, selected, ...(typeof response.otherText === 'string' && response.otherText.trim() ? { custom: response.otherText.trim() } : {}) }
}

async function askQuestions(request) {
  const agent = request.agent
  const entry = agent ? handles.get(String(agent.id)) : undefined
  if (!entry) throw new Error('user question has no active DSH session')
  const answers = []
  for (let index = 0; index < request.questions.length; index += 1) {
    const question = request.questions[index]
    const pending = interactionForQuestion(entry, request, question, index)
    const response = await askHost(entry, pending)
    if (response?.action === 'cancel' || request.signal?.aborted) throw new Error('user cancelled the question')
    const answer = selectedQuestionAnswer(question, response)
    if (!answer) throw new Error('question response was not accepted')
    answers.push(answer)
  }
  return { answers }
}

async function disposeAll() {
  const entries = [...handles.values()]
  handles.clear()
  await Promise.all(entries.map(entry => entry.handle.dispose().catch(() => undefined)))
}

async function shutdown() {
  await disposeAll()
  socket?.end()
  return { shutdown: true }
}

function onSocketMessage(message) {
  try { receiveMessage(JSON.parse(message)) } catch (error) {
    notify('bridge/error', { message: error instanceof Error ? error.message : String(error) })
  }
}

async function connect(config) {
  const endpoint = requiredString(config.endpoint, 'endpoint')
  const token = requiredString(config.token, 'token')
  const url = new URL(endpoint)
  const port = Number(url.port)
  if (url.protocol !== 'tcp:' || url.hostname !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('endpoint must be a loopback TCP URL')
  }
  const client = net.createConnection({ host: '127.0.0.1', port })
  await new Promise((resolve, reject) => {
    client.once('connect', resolve)
    client.once('error', reject)
  })
  socket = client
  let buffer = Buffer.alloc(0)
  client.on('data', chunk => {
    let offset = 0
    while (offset < chunk.length) {
      const boundary = chunk.indexOf(0x0a, offset)
      if (boundary < 0) {
        const tail = chunk.subarray(offset)
        if (buffer.length + tail.length > MAX_FRAME_BYTES) { client.destroy(new Error('workbench DSH bridge frame exceeded limit')); return }
        buffer = buffer.length ? Buffer.concat([buffer, tail]) : tail
        return
      }
      const segment = chunk.subarray(offset, boundary)
      const frame = buffer.length ? Buffer.concat([buffer, segment]) : segment
      buffer = Buffer.alloc(0)
      if (frame.length > MAX_FRAME_BYTES) { client.destroy(new Error('workbench DSH bridge frame exceeded limit')); return }
      offset = boundary + 1
      if (frame.length) onSocketMessage(frame.toString('utf8'))
    }
  })
  client.on('close', () => {
    for (const pending of hostRequests.values()) pending.reject(new Error('workbench DSH bridge disconnected'))
    hostRequests.clear()
  })
  const ready = await callHost('bridge/ready', { token, protocolVersion: PROTOCOL_VERSION, profileName: config.profileName })
  if (ready?.protocolVersion !== PROTOCOL_VERSION) throw new Error('workbench DSH bridge protocol version mismatch')
}

export async function apply(ctx, config) {
  runtimeContext = ctx
  // Optional by design: `inject` above lists what this bridge cannot work without, and the
  // projection registry is only the context popover's composition detail.
  ctx.inject(['sessionProjections'], (scope) => { projections = scope.sessionProjections })
  ctx.inject(['permissionPresets'], (scope) => { permissionPresets = scope.permissionPresets })
  ctx.inject(['skills'], (scope) => { skills = scope.skills })
  ctx.inject(['jobs'], (scope) => {
    jobs = scope.jobs
    const unsubscribe = jobs.events.subscribe({ owners: 'all' }, onJobEvent)
    scope.effect(() => () => { unsubscribe(); if (jobs === scope.jobs) jobs = undefined })
  })
  const sessionEvents = ctx.on('session/event', (session, event) => {
    const entry = handles.get(String(session.id))
    if (!entry) { noteUnhandledEvent(session, event); return }
    noteChildren(entry.nativeSessionId, session, event)
    describeSessionEvent(entry, session, event)
  }, { global: true })
  const statusEvents = ctx.on('agent/status', ({ agent, status }) => {
    const entry = handles.get(String(agent.session.id))
    if (entry) mapAgent(entry, { status })
  }, { global: true })
  const streamEvents = ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const entry = handles.get(String(agent.session.id))
    if (!entry) return
    if (frame.type === 'end' && frame.outcome.kind === 'committed') entry.streamedSeqs.add(frame.outcome.seq)
    mapAgent(entry, { assistantStream: frame, eventSequence: entry.latestSequence ?? 0 })
  }, { global: true })
  const disposedEvents = ctx.on('agent/disposed', ({ agent }) => {
    const nativeSessionId = String(agent.session.id)
    const entry = handles.get(nativeSessionId)
    if (entry?.agent === agent) {
      handles.delete(nativeSessionId)
      notify('agent/status', { nativeSessionId, sessionId: entry.workbenchSessionId, status: 'disposed' })
    }
  }, { global: true })
  const approvalEvents = ctx.on('approval/request', async (request, next) => {
    if (!handles.has(String(request.agent.id))) return await next()
    return await askPermission(request)
  }, { global: true })
  const questionEvents = ctx.on('user-questions/request', async (request, next) => {
    if (!request.agent || !handles.has(String(request.agent.id))) return await next()
    return await askQuestions(request)
  }, { global: true })
  ctx.effect(() => async () => {
    sessionEvents(); statusEvents(); streamEvents(); disposedEvents(); approvalEvents(); questionEvents()
    await disposeAll()
    socket?.destroy()
  }, 'riffet.dsh-native-bridge')
  await connect(config)
  notify('bridge/connected', { protocolVersion: PROTOCOL_VERSION, profileName: config.profileName })
}
