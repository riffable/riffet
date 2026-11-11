package riffet.ui.quickchat

import riffet.ui.app.adaptiveModalViewport
import riffet.ui.app.RiffetPageScaffold
import riffet.ui.design.materialBackdropEnabled
import androidx.compose.foundation.layout.PaddingValues

import androidx.compose.ui.graphics.Color

import riffet.ui.design.riffetMaterial
import riffet.ui.design.MaterialRole
import riffet.ui.design.RiffetMaterialContent
import riffet.ui.design.RiffetMaterialWindow
import riffet.ui.pickers.pickerSheetMaxHeight
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.heightIn

import riffet.ui.design.LocalRiffetSurfaces
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.design.RiffetTextButton
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import riffet_mobile.shared.generated.resources.pickers_close
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.ExperimentalMaterial3Api
import riffet.ui.icons.Icon
import riffet.ui.design.RiffetIconButton as IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.backhandler.BackHandler
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.jetbrains.compose.resources.getString
import org.jetbrains.compose.resources.stringResource
import riffet.contracts.Attachment
import riffet.contracts.NativeBackendId
import riffet.contracts.Project
import riffet.contracts.Session
import riffet.shared.RiffetApi
import riffet.ui.composer.AttachmentIntakeError
import riffet.ui.home.latestQuickChatModel
import riffet.ui.composer.Composer
import riffet.ui.composer.ComposerCard
import riffet.ui.composer.ComposerSettings
import riffet.ui.composer.attachmentIntakeError
import riffet.ui.composer.rememberAttachmentPicker
import riffet.ui.home.HomeConfig
import riffet.ui.icons.RiffetIcons
import riffet.ui.pickers.LocalPickerHost
import riffet.ui.pickers.ModelPickerPages
import riffet.ui.pickers.PickerPages
import riffet.ui.pickers.rememberPickerHost
import riffet.ui.pickers.modelSelectionSummary
import riffet.ui.session.PreviousTimeline
import riffet.ui.state.SessionStore
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet.ui.timeline.prepareTranscriptMarkdown
import riffet.ui.timeline.ProcessFolds
import riffet.ui.timeline.ImageViewerHost
import riffet.ui.timeline.Timeline
import riffet.ui.timeline.TimelinePresenter
import riffet.ui.timeline.layoutTimeline
import riffet_mobile.shared.generated.resources.Res
import riffet_mobile.shared.generated.resources.composer_attachment_too_large
import riffet_mobile.shared.generated.resources.composer_attachments_limit
import riffet_mobile.shared.generated.resources.composer_placeholder_online
import riffet_mobile.shared.generated.resources.session_attachment_upload_failed
import riffet_mobile.shared.generated.resources.session_attachment_uploading
import riffet_mobile.shared.generated.resources.session_create_session_failed
import riffet_mobile.shared.generated.resources.session_default_model
import riffet_mobile.shared.generated.resources.session_expand
import riffet_mobile.shared.generated.resources.session_quick_chat

/**
 * The quick chat entry as a bottom sheet over whatever app the reader was in.
 *
 * The sheet creates the conversation through the same `SessionStore.createSession` path as the
 * quick chat home, then renders the live transcript and the existing composer. It owns no
 * connection: [store] and [api] are the process-scoped host's. Dismissing only finishes the sheet;
 * the chat itself stays in the sidebar. [onExpand] hands the open chat to the full app.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QuickChatSheet(
    api: RiffetApi,
    store: SessionStore,
    project: Project,
    initialText: String,
    initialMode: String?,
    onDismiss: () -> Unit,
    /**
     * The open chat's id (null before the first send), and the draft to carry into the full page
     * when there is no chat yet.
     */
    onExpand: (sessionId: String?, text: String, attachments: List<Attachment>) -> Unit,
    /** Already uploaded by the entry, e.g. an image shared into the quick chat. */
    initialAttachments: List<Attachment> = emptyList(),
    /** Outlives the sheet, so dismissing it mid-send cannot cancel the creation. */
    writeScope: CoroutineScope? = null,
) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    val typography = LocalRiffetTypography.current
    val sheet = LocalInterfaceStyle.current.components.sheets
    val scope = rememberCoroutineScope()
    val workScope = writeScope ?: scope
    val list by store.list.collectAsState()
    // The sheet's transcript has its own selection; opening it must not move the main app's stream.
    val previewStore = remember(api, scope) { SessionStore(api = api, scope = scope) }
    DisposableEffect(previewStore) {
        onDispose { previewStore.clear() }
    }
    LaunchedEffect(previewStore, list.settings) {
        list.settings?.let(previewStore::applySavedSettings)
    }
    val config = remember(api, project.id, initialMode) {
        HomeConfig(api, scope, quickChat = true, initialMode = initialMode)
    }
    val recentModel = latestQuickChatModel(list.sessions, project.id)
    LaunchedEffect(config, project.id, list.settings, recentModel) {
        config.load(project.id, list.settings, recentModel = recentModel)
    }

    var text by remember(initialText) { mutableStateOf(initialText) }
    var attachments by remember { mutableStateOf(initialAttachments) }
    var thumbnails by remember { mutableStateOf<Map<String, ImageBitmap>>(emptyMap()) }
    var uploading by remember { mutableStateOf(false) }
    var creating by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var modelOpen by remember { mutableStateOf(false) }
    var open by remember { mutableStateOf<Session?>(null) }
    val presenter = remember(previewStore) { TimelinePresenter(previewStore, scope, prepare = ::prepareTranscriptMarkdown) }
    val selected by previewStore.selected.collectAsState()
    val presentation by presenter.presentation.collectAsState()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    val modelLabel = modelSelectionSummary(config.catalog, config.model).ifEmpty {
        config.model.ifEmpty { stringResource(Res.string.session_default_model) }
    }
    val createFailed = stringResource(Res.string.session_create_session_failed)
    val attachmentUploadingNotice = stringResource(Res.string.session_attachment_uploading)
    val attachmentUploadFailed = stringResource(Res.string.session_attachment_upload_failed)
    val picker = rememberAttachmentPicker(onError = { error = it }) { picked ->
        if (picked.isEmpty()) return@rememberAttachmentPicker
        if (uploading) {
            error = attachmentUploadingNotice
            return@rememberAttachmentPicker
        }
        attachmentIntakeError(picked, attachments.size)?.let { failure ->
            workScope.launch {
                error = when (failure) {
                    is AttachmentIntakeError.TooMany -> getString(Res.string.composer_attachments_limit, failure.limit)
                    is AttachmentIntakeError.TooLarge -> getString(Res.string.composer_attachment_too_large, failure.name)
                }
            }
            return@rememberAttachmentPicker
        }
        workScope.launch {
            uploading = true
            error = null
            try {
                val uploaded = picked.map { store.uploadAttachment(it, project.id) }
                attachments = attachments + uploaded
                picked.zip(uploaded).forEach { (item, attachment) ->
                    item.thumbnail?.let { thumbnails = thumbnails + (attachment.id to it) }
                }
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                error = failure.message?.takeIf { it.isNotBlank() } ?: attachmentUploadFailed
            } finally {
                uploading = false
            }
        }
    }

    fun create() {
        val prompt = text.trim()
        if (prompt.isEmpty() || creating) return
        creating = true
        error = null
        val sentAttachments = attachments
        workScope.launch {
            try {
                val session = store.createSession(
                    projectId = project.id,
                    prompt = prompt,
                    attachments = sentAttachments,
                    backendId = NativeBackendId.CHAT,
                    backendProfileId = null,
                    model = config.model.takeIf { it.isNotBlank() },
                    mode = config.mode,
                    approval = null,
                )
                if (!scope.isActive) return@launch
                text = ""
                attachments = emptyList()
                thumbnails = emptyMap()
                open = session
                previewStore.select(session)
            } catch (cancellation: CancellationException) {
                throw cancellation
            } catch (failure: Throwable) {
                error = failure.message?.takeIf { it.isNotBlank() } ?: createFailed
            } finally {
                creating = false
            }
        }
    }

    // The model list is a page of this sheet, not a second sheet over it: a picker drawn in the
    // activity's window would sit under this sheet's own window.
    val page = when {
        modelOpen -> QuickChatPage.Model
        open != null -> QuickChatPage.Transcript
        else -> QuickChatPage.Chat
    }
    val pickerHost = rememberPickerHost { modelOpen = false }

    val panelShape = RoundedCornerShape(topStart = metrics.groupRadius, topEnd = metrics.groupRadius)
    val density = LocalDensity.current
    var handleHeight by remember { mutableStateOf(0.dp) }
    // This system-entry sheet has its own Activity, outside the workbench's image host.
    ImageViewerHost(owner = previewStore to open?.id) {
    RiffetMaterialWindow {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        modifier = Modifier.adaptiveModalViewport().riffetMaterial(MaterialRole.SHEET, panelShape,
            if (sheet.tonalSurface) LocalRiffetSurfaces.current.groupedPage else colors.bgSubtle),
        containerColor = Color.Transparent,
        sheetMaxWidth = minOf(metrics.sheetMaxWidth, 640.dp),
        contentColor = colors.fg,
        shape = panelShape,
        dragHandle = {
            Box(Modifier.onSizeChanged { handleHeight = with(density) { it.height.toDp() } }) {
            if (sheet.nativeDragHandle) BottomSheetDefaults.DragHandle()
            else BottomSheetDefaults.DragHandle(width = 36.dp, height = 4.dp, shape = CircleShape,
                color = colors.fg4.copy(alpha = 0.4f))
            }
        },
    ) {
        RiffetMaterialContent {
        BackHandler(enabled = modelOpen) { pickerHost.requestBack() }
        CompositionLocalProvider(LocalPickerHost provides pickerHost) {
            BoxWithConstraints(Modifier.fillMaxWidth()) {
            // Native Material measures the handle before content; its default padding belongs to
            // the sheet's total cap, rather than adding height after the 70% calculation.
            val contentCap = (pickerSheetMaxHeight(maxHeight + handleHeight, sheet) - handleHeight).coerceAtLeast(0.dp)
            PickerPages(page = page, depth = { it.depth }, modifier = Modifier.fillMaxWidth().heightIn(max = contentCap)) { shown ->
                if (shown == QuickChatPage.Model) {
                    Box(Modifier.fillMaxWidth().fillMaxHeight().imePadding().padding(bottom = 12.dp)) {
                        ModelPickerPages(
                            catalog = config.catalog,
                            catalogLoading = config.catalogLoading,
                            catalogError = config.catalogError,
                            selection = config.model,
                            switching = false,
                            disabledReason = null,
                            // The page's own pick closes it through the host, back to the chat page.
                            onSelect = { config.model = it },
                            onParamChange = { config.model = it },
                            onBack = { modelOpen = false },
                            onRetryCatalog = { config.load(project.id, store.list.value.settings, force = true) },
                            usageScopeKey = "chat|${project.id}",
                            showSubtitle = false,
                        )
                    }
                    return@PickerPages
                }
                val header: @Composable () -> Unit = {
                    val showDivider = !materialBackdropEnabled
                    if (!sheet.nativeDragHandle) Box(Modifier.fillMaxWidth().height(metrics.controlHeight).drawWithContent {
                        drawContent()
                        if (showDivider) drawLine(colors.line, Offset(0f, size.height), Offset(size.width, size.height), strokeWidth = metrics.hairlineWidth.toPx())
                    }) {
                        IconButton(onClick = onDismiss, modifier = Modifier.align(Alignment.CenterStart)) {
                            Box(Modifier.size(28.dp).background(colors.bgMuted, CircleShape), contentAlignment = Alignment.Center) {
                                Icon(RiffetIcons.Close, stringResource(Res.string.pickers_close), Modifier.size(16.dp), tint = colors.fg3)
                            }
                        }
                        Text(
                            stringResource(Res.string.session_quick_chat), style = typography.barTitle, color = colors.fg,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.align(Alignment.Center).padding(horizontal = 72.dp),
                        )
                        RiffetTextButton(
                            onClick = { onExpand(open?.id, text, attachments) },
                            modifier = Modifier.align(Alignment.CenterEnd),
                        ) { Text(stringResource(Res.string.session_expand), style = typography.button) }
                    } else Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = stringResource(Res.string.session_quick_chat),
                            style = typography.title,
                            color = colors.fg,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        IconButton(onClick = { onExpand(open?.id, text, attachments) }) {
                            Icon(RiffetIcons.ExternalLink, contentDescription = stringResource(Res.string.session_expand), tint = colors.fg2)
                        }
                    }
                    Spacer(Modifier.height(4.dp))
                }
                val openSession = open
                if (shown == QuickChatPage.Transcript && openSession != null) {
                    val current = selected?.takeIf { it.id == openSession.id } ?: openSession
                    val activePresentation = presentation?.takeIf { it.sessionId == openSession.id }
                    val grouping = activePresentation?.grouping
                    val rows = grouping?.rows.orEmpty()
                    val folds = remember(openSession.id) { ProcessFolds() }
                    val previous = remember(openSession.id) { PreviousTimeline() }
                    val layout = remember(grouping, folds, folds.version) {
                        folds.sync(rows)
                        layoutTimeline(rows, previous.layout, folds::isOpen).also { previous.layout = it }
                    }
                    val listState = rememberLazyListState()
                    RiffetMaterialWindow {
                        RiffetPageScaffold(
                            modifier = Modifier.fillMaxSize().imePadding(),
                            extendSystemBars = false,
                            floatingBottomBar = true,
                            topBar = {
                                Column(Modifier.fillMaxWidth().padding(horizontal = metrics.pageInset)) { header() }
                            },
                            bottomBar = {
                                Column(Modifier.fillMaxWidth()) {
                                    Composer(
                                        store = previewStore,
                                        session = current,
                                        writeScope = writeScope,
                                        settings = ComposerSettings(
                                            label = modelSelectionSummary(config.catalog, current.model).ifEmpty {
                                                current.model.orEmpty().ifEmpty { modelLabel }
                                            },
                                            icon = RiffetIcons.Message,
                                            enabled = false,
                                            onOpen = {},
                                        ),
                                    )
                                }
                            },
                        ) { chromePadding ->
                            Box(modifier = Modifier.fillMaxSize()) {
                                Timeline(
                                    contentPadding = PaddingValues(
                                        start = metrics.pageInset, end = metrics.pageInset,
                                        top = chromePadding.calculateTopPadding(), bottom = chromePadding.calculateBottomPadding(),
                                    ),
                                    layout = layout,
                                    tail = grouping?.items?.lastOrNull(),
                                    onToggleProcess = folds::toggle,
                                    modifier = Modifier.fillMaxSize(),
                                    speeds = activePresentation?.speeds.orEmpty(),
                                    listState = listState,
                                )
                            }
                        }
                    }
                    return@PickerPages
                }
                Column(
                    modifier = Modifier.fillMaxWidth().imePadding()
                        .padding(start = metrics.pageInset, end = metrics.pageInset, bottom = metrics.controlInset),
                ) {
                    header()
                    val modes = config.capabilities?.modes.orEmpty()
                    if (modes.size > 1) {
                        QuickChatModeChips(options = modes, value = config.mode, onSelect = { config.mode = it })
                        Spacer(Modifier.height(8.dp))
                        QuickChatPresetPrompt(options = modes, value = config.mode)
                        Spacer(Modifier.height(12.dp))
                    }
                    ComposerCard(
                        text = text,
                        onTextChange = { text = it },
                        placeholder = stringResource(Res.string.composer_placeholder_online),
                        attachments = attachments,
                        thumbnails = thumbnails,
                        uploading = uploading,
                        onRemoveAttachment = { id ->
                            attachments = attachments.filterNot { it.id == id }
                            thumbnails = thumbnails - id
                        },
                        onAttach = if (picker.available) ({ picker.launch() }) else null,
                        settings = ComposerSettings(
                            label = modelLabel,
                            icon = RiffetIcons.Message,
                            enabled = !creating,
                            onOpen = { modelOpen = true },
                            loading = config.catalogLoading,
                            error = config.catalogError != null,
                        ),
                        sendEnabled = text.isNotBlank() && !uploading && !creating && !config.catalogLoading,
                        sendBusy = creating,
                        onSend = ::create,
                        hero = true,
                    )
                    Spacer(Modifier.height(8.dp))
                    error?.let {
                        Text(it, style = typography.caption, color = colors.danger)
                    }
                }
            }
        }
    }
    }
    }
    }
    }
}

/** What the sheet shows: the composer, the live transcript after the first send, or the model list over either. */
private enum class QuickChatPage(val depth: Int) {
    Chat(0),
    Transcript(0),
    Model(1),
}
