package riffet.shared

import riffet.contracts.AppSettings
import riffet.contracts.AssistantDelegation
import riffet.contracts.AssistantDelegations
import riffet.contracts.AssistantInstructions
import riffet.contracts.AssistantInstructionsUpdate
import riffet.contracts.AssistantMemory
import riffet.contracts.AssistantPack
import riffet.contracts.AssistantPacks
import riffet.contracts.AssistantRunUsage
import riffet.contracts.AssistantSettingsPatch
import riffet.contracts.AssistantSettingsUpdate
import riffet.contracts.AgentIds
import riffet.contracts.NativeBackendId
import riffet.contracts.WorkItemSettingsPatch
import riffet.contracts.WorkItemSettingsUpdate

/** `GET /api/assistant/instructions`: the 助理's `AGENTS.md`. */
@Throws(Exception::class)
suspend fun RiffetApi.assistantInstructions(): AssistantInstructions = get("/api/assistant/instructions").decode()

/** `PUT /api/assistant/instructions`; a null [text] restores Riffet's own. */
@Throws(Exception::class)
suspend fun RiffetApi.saveAssistantInstructions(text: String?): AssistantInstructions =
    put("/api/assistant/instructions", wireBody(AssistantInstructionsUpdate(AssistantSettingsUpdate.clearable(text)))).decode()

/** `GET /api/assistant/memory`: what the 助理 remembers, read-only. */
@Throws(Exception::class)
suspend fun RiffetApi.assistantMemory(): AssistantMemory = get("/api/assistant/memory").decode()

/** `GET /api/assistant/delegations`: what the 助理 follows over time. */
@Throws(Exception::class)
suspend fun RiffetApi.assistantDelegations(): List<AssistantDelegation> =
    get("/api/assistant/delegations").decode<AssistantDelegations>().delegations

/** `POST /api/assistant/delegations/:id/end`. */
@Throws(Exception::class)
suspend fun RiffetApi.endAssistantDelegation(id: String): AssistantDelegation =
    post("/api/assistant/delegations/$id/end").decode()

/** The agent and model the 助理's composer started a conversation with, saved so every device opens on them. */
@Throws(Exception::class)
suspend fun RiffetApi.rememberAssistant(backendId: NativeBackendId, profileId: String?, model: String?): AppSettings =
    patchAssistant(AssistantSettingsUpdate(
        backendId = backendId,
        profileId = AssistantSettingsUpdate.clearable(profileId),
        model = AssistantSettingsUpdate.clearable(model?.takeIf { it.isNotBlank() }),
    ))

/** Tells the server the owner's time zone, which the 助理 is told the time in. */
@Throws(Exception::class)
suspend fun RiffetApi.reportAssistantTimeZone(zone: String): AppSettings =
    patchAssistant(AssistantSettingsUpdate(timeZone = zone))

/** `GET /api/assistant/runs/usage`: what the background runs cost lately. */
@Throws(Exception::class)
suspend fun RiffetApi.assistantRunUsage(): AssistantRunUsage = get("/api/assistant/runs/usage").decode()

/** `GET /api/assistant/packs`: Riffet's capability packs and the owner's own, installed or not. */
@Throws(Exception::class)
suspend fun RiffetApi.assistantPacks(): List<AssistantPack> = get("/api/assistant/packs").decode<AssistantPacks>().packs

/** Adds one of Riffet's packs; the main conversation's CLI loads it once it rests. Returns the list after. */
@Throws(Exception::class)
suspend fun RiffetApi.addAssistantPack(id: String): List<AssistantPack> = put("/api/assistant/packs/$id").decode<AssistantPacks>().packs

/** Removes a pack's folder; its memory stays. Returns the list after. */
@Throws(Exception::class)
suspend fun RiffetApi.removeAssistantPack(id: String): List<AssistantPack> = delete("/api/assistant/packs/$id").decode<AssistantPacks>().packs

/** 跟进任务 (docs/ASSISTANT.md §7.6). */
@Throws(Exception::class)
suspend fun RiffetApi.setAssistantSupervision(on: Boolean): AppSettings = patchAssistant(AssistantSettingsUpdate(supervision = on))

/** 记忆整理. */
@Throws(Exception::class)
suspend fun RiffetApi.setAssistantConsolidation(on: Boolean): AppSettings = patchAssistant(AssistantSettingsUpdate(consolidation = on))

/** 开始任务前: `edits` or `all`. */
@Throws(Exception::class)
suspend fun RiffetApi.setAssistantDispatch(value: String): AppSettings = patchAssistant(AssistantSettingsUpdate(dispatch = value))

/** 24 小时内最多. */
@Throws(Exception::class)
suspend fun RiffetApi.setAssistantDailyRuns(count: Int): AppSettings = patchAssistant(AssistantSettingsUpdate(dailyRuns = count))

private suspend fun RiffetApi.patchAssistant(update: AssistantSettingsUpdate): AppSettings =
    patch("/api/settings", wireBody(AssistantSettingsPatch(update))).decode()

/** 任务看板: 新会话作为任务. */
@Throws(Exception::class)
suspend fun RiffetApi.setWorkItemComposerSessions(on: Boolean): AppSettings = patchWorkItems(WorkItemSettingsUpdate(composerSessions = on))

/** 任务看板's agent and model for new tasks; a null [backendId] clears all three, a null [model] only the model. */
@Throws(Exception::class)
suspend fun RiffetApi.setWorkItemAgent(backendId: NativeBackendId?, profileId: String?, model: String?): AppSettings =
    patchWorkItems(WorkItemSettingsUpdate(
        backendId = AssistantSettingsUpdate.clearable(backendId?.let(AgentIds::wire)),
        profileId = AssistantSettingsUpdate.clearable(if (backendId == null) null else profileId),
        model = AssistantSettingsUpdate.clearable(if (backendId == null) null else model?.takeIf { it.isNotBlank() }),
    ))

private suspend fun RiffetApi.patchWorkItems(update: WorkItemSettingsUpdate): AppSettings =
    patch("/api/settings", wireBody(WorkItemSettingsPatch(update))).decode()
