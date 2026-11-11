package riffet.contracts

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Mirrors packages/contracts/src/extensions.ts. Provider-specific vocabulary stays open. */
@Serializable
data class ExtensionContext(val backendId: NativeBackendId, val profileId: String, val projectId: String? = null)

@Serializable
data class ExtensionItem(
    val id: String, val kind: String, val name: String, val scope: String,
    val runtimeState: String = "unknown", val description: String? = null,
    val sourcePath: String? = null, val ownerPluginId: String? = null,
    val nativeId: String? = null, val enabled: Boolean? = null,
    val readOnlyReason: String? = null, val documentId: String? = null,
    val actions: List<String>? = null,
    /** How this item is managed and what its actions touch, when the server has something to say. */
    val managementNote: String? = null,
)

@Serializable
data class ExtensionFile(val id: String, val path: String, val editable: Boolean, val reason: String? = null)

@Serializable
data class ExtensionDocument(
    val id: String, val path: String, val editable: Boolean, val content: String,
    @SerialName("hash") val contentHash: String,
    val language: String, val applyEffect: String, val reason: String? = null,
    val validationNote: String? = null,
)

@Serializable
data class ExtensionDetail(val item: ExtensionItem, val files: List<ExtensionFile> = emptyList())

@Serializable
data class ExtensionCreateTarget(
    val id: String, val label: String, val kind: String, val scope: String,
    val directory: String, val fileName: String? = null, val template: String? = null,
)

@Serializable
data class ExtensionInventory(
    val backendId: NativeBackendId, val profileId: String,
    val items: List<ExtensionItem> = emptyList(), val diagnostics: List<String> = emptyList(),
    val createTargets: List<ExtensionCreateTarget> = emptyList(), val checkedAt: String,
)

@Serializable
data class ExtensionManagementCapabilities(
    val actions: List<String> = emptyList(), val kinds: Map<String, List<String>> = emptyMap(), val reason: String? = null,
    val installScopes: List<String> = listOf("user"),
)

@Serializable
/** [expectedHash] is the Skill main file's content hash; the server refuses Skill actions without it. */
data class ExtensionActionRequest(val action: String, val itemId: String? = null, val target: String? = null, val scope: String? = null, val expectedHash: String? = null)

@Serializable
data class ExtensionActionResult(val success: Boolean, val applyEffect: String, val output: String? = null, val diagnostics: List<String>? = null, val authorizationUrl: String? = null)

@Serializable
data class ExtensionRuntimeEntry(
    val sessionId: String, val kind: String, val name: String, val state: String,
    val sourcePath: String? = null, val enabled: Boolean? = null,
    val message: String? = null, val tools: List<String>? = null,
)

/** `GET /api/backends/:id/loaded-extensions`: what a launch in the project loads, for the per-conversation switches. */
@Serializable
data class LoadedExtensions(
    val mcp: List<LoadedMcp> = emptyList(),
    val skills: List<LoadedSkill> = emptyList(),
    val checkedAt: String,
)

@Serializable
data class LoadedMcp(val name: String, val tools: Int? = null)

@Serializable
data class LoadedSkill(val name: String, val description: String? = null)

/** Which kinds of installed extensions a conversation can switch off (`Session.extensionsOff`). */
@Serializable
data class ExtensionToggles(val mcp: Boolean = false, val skills: Boolean = false)

@Serializable
data class ExtensionRuntimeReport(val entries: List<ExtensionRuntimeEntry> = emptyList(), val diagnostics: List<String> = emptyList(), val checkedAt: String)
