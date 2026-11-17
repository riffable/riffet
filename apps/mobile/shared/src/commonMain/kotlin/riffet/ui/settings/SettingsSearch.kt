package riffet.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntSize
import kotlinx.coroutines.delay
import org.jetbrains.compose.resources.StringResource
import org.jetbrains.compose.resources.stringResource
import riffet.shared.NativeFeature
import riffet.shared.appIconSupported
import riffet.shared.supported
import riffet.ui.app.LocalPageActive
import riffet.ui.design.LocalInterfaceStyle
import riffet.ui.icons.Icon
import riffet.ui.icons.RiffetIcons
import riffet.ui.platform.VerificationAvailability
import riffet.ui.platform.approvalVerificationAvailability
import riffet.ui.theme.LocalRiffetColors
import riffet.ui.theme.LocalRiffetTypography
import riffet_mobile.shared.generated.resources.*

/** One catalogue owns discovery and destinations; renderers only expose their existing labels. */
internal data class SettingsSearchEntry(
    val id: String,
    val section: SettingsSection,
    val title: StringResource,
    val aliases: String,
    val anchor: SettingsSearchAnchor? = SettingsSearchAnchor.ROW,
    val available: () -> Boolean = { true },
)

internal enum class SettingsSearchAnchor { GROUP, ROW }
internal data class SettingsSearchTarget(val id: String, val title: String, val anchor: SettingsSearchAnchor)
internal val LocalSettingsSearchTarget = staticCompositionLocalOf<SettingsSearchTarget?> { null }

private val sectionAliases = mapOf(
    SettingsSection.LAUNCH_TAB to "launch start tab assistant default open 启动 默认 打开 助理 标签 qidong moren dakai zhuli biaoqian",
    SettingsSection.LANGUAGE to "language locale follow system simplified chinese english 语言 跟随系统 简体中文 中文 英文 英语 yuyan gen sui xi tong jian ti zhong wen ying wen ying yu yy",
    SettingsSection.MOTION to "motion animation transition 动效 动画 dongxiao donghua",
    SettingsSection.GESTURES to "gestures swipe back haptics vibration interaction 手势 返回 触觉 振动 shoushi fanhui chujue jiaohu",
    SettingsSection.STYLE to "interface style material expressive miuix fluent ios glass liquid frosted blur 材质 玻璃 液态 磨砂 fengge jiemian yangshi caizhi boli",
    SettingsSection.APPEARANCE to "theme palette colors appearance 配色 颜色 明暗 zhuti peise waiguan zt",
    SettingsSection.TYPOGRAPHY to "typography font text spacing 字体 字号 字间距 paiban ziti zihao wenzi jianju pb",
    SettingsSection.ICONS to "icons lucide fluent mdi remix octicons tubiao",
    SettingsSection.INTERACTION to "input approval security shuru shenpi anquan",
    SettingsSection.NOTIFICATIONS to "notifications background alerts tongzhi houtai tixing",
    SettingsSection.FILES to "files editor access wenjian bianjiqi fangwen",
    SettingsSection.BACKENDS to "models provider backend cursor claude codex gemini openai ollama moxing tigongshang",
    SettingsSection.AUXILIARY to "auxiliary models title summary fuzhu moxing biaoti zhaiyao",
    SettingsSection.QUICK_CHAT to "quick chat prompts retention kuaisu liaotian duihua",
    SettingsSection.TASK_BOARD to "task board work items composer sessions default agent model renwu kanban",
    SettingsSection.ASSISTANT to "personal assistant background runs follow up memory delegations 个人助理 助理 后台运行 委托 gerenzhuli zhuli houtai yunxing weituo",
    SettingsSection.CONNECTION to "connection server pairing lianjie fuwuqi peidui",
    SettingsSection.SERVICE to "service status reclaim cpu memory fuwu zhuangtai huishou neicun",
    SettingsSection.DIAGNOSTICS to "diagnostics logs environment benchmark zhenduan rizhi huanjing",
    SettingsSection.ABOUT to "about version license guanyu banben xukezheng",
    SettingsSection.EXTENSIONS to "extensions plugin skill mcp hook rules kuozhan chajian jineng guize",
    SettingsSection.DEVICES to "capabilities device control accessibility permissions clipboard nengli shebei kongzhi wuzhangai quanxian jiantieban",
)

/** Pinyin syllables also provide initials; aliases stay local and never require a server lookup. */
private fun aliases(english: String, pinyin: String): String =
    english + " " + pinyin + " " + pinyin.split(' ').filter(String::isNotEmpty).joinToString("") { it.first().toString() }

internal val settingsSearchCatalogue: List<SettingsSearchEntry> = buildList {
    SettingsSection.entries.forEach { section ->
        add(SettingsSearchEntry("section." + section.name.lowercase(), section, section.title, sectionAliases[section].orEmpty(), anchor = null))
    }
    fun row(id: String, section: SettingsSection, title: StringResource, english: String, pinyin: String,
            available: () -> Boolean = { true }) {
        add(SettingsSearchEntry(id, section, title, aliases(english, pinyin), available = available))
    }
    fun group(id: String, section: SettingsSection, title: StringResource, english: String, pinyin: String,
              available: () -> Boolean = { true }) {
        add(SettingsSearchEntry(id, section, title, aliases(english, pinyin), SettingsSearchAnchor.GROUP, available))
    }
    // Found on a page beneath the section's own: the result opens the section, which leads there.
    fun beneath(id: String, section: SettingsSection, title: StringResource, english: String, pinyin: String) {
        add(SettingsSearchEntry(id, section, title, aliases(english, pinyin), anchor = null))
    }
    row("language.system", SettingsSection.LANGUAGE, Res.string.settings_language_system, "language locale follow system 语言 跟随系统", "yu yan gen sui xi tong")
    row("language.chinese", SettingsSection.LANGUAGE, Res.string.settings_language_chinese, "language locale simplified chinese 语言 简体中文 中文", "yu yan jian ti zhong wen")
    row("language.english", SettingsSection.LANGUAGE, Res.string.settings_language_english, "language locale english 语言 英文 英语", "yu yan ying wen ying yu")
    row("motion.page-animation", SettingsSection.MOTION, Res.string.settings_page_animation, "page tab animation transition motion slide fade scale none 页面 动效 动画 标签 切换 滑动 淡入淡出 缩放 无动效", "ye mian dong xiao dong hua biao qian qie huan hua dong dan ru dan chu suo fang wu dong xiao")
    row("gestures.swipe-back", SettingsSection.GESTURES, Res.string.settings_swipe_back, "swipe back gesture", "hua dong fan hui") { NativeFeature.SWIPE_BACK.supported }
    row("gestures.predictive-back", SettingsSection.GESTURES, Res.string.settings_predictive_back, "predictive back gesture", "yu ce fan hui") { NativeFeature.PREDICTIVE_BACK.supported }
    row("motion.fade", SettingsSection.MOTION, Res.string.settings_fade_in, "fade in animation reduced motion", "xin nei rong dan ru dong hua") { NativeFeature.FADE_IN.supported }
    row("gestures.haptics", SettingsSection.GESTURES, Res.string.settings_haptics, "haptics vibration 震动 振动", "chu jue fan kui zhen dong") { NativeFeature.HAPTICS.supported }
    group("appearance.mode", SettingsSection.APPEARANCE, Res.string.settings_appearance, "light dark system mode", "ming an mo shi gen sui xi tong")
    row("appearance.amoled", SettingsSection.APPEARANCE, Res.string.settings_amoled, "amoled oled black", "chun hei hei se")
    group("appearance.code-theme", SettingsSection.APPEARANCE, Res.string.settings_code_theme, "code syntax highlighting theme intellij github vitesse catppuccin solarized monochrome 代码 高亮 语法", "dai ma gao liang yu fa feng ge")
    group("appearance.material", SettingsSection.STYLE, Res.string.settings_surface_material, "surface material solid frosted blur glass liquid strength 纯色 磨砂 玻璃 液态 通透 强度", "biao mian cai zhi chun se mo sha bo li ye tai qiang du")
    row("appearance.resources", SettingsSection.APPEARANCE, Res.string.settings_appearance_resources, "appearance resources plugins", "wai guan zi yuan cha jian")
    beneath("appearance.preset", SettingsSection.APPEARANCE, Res.string.settings_appearance_preset, "preset appearance", "yu she")
    beneath("appearance.palette", SettingsSection.APPEARANCE, Res.string.settings_appearance_palette, "palette color theme", "pei se zhu ti")
    beneath("appearance.ui-font", SettingsSection.APPEARANCE, Res.string.settings_appearance_ui_font, "interface font typeface", "jie mian zi ti")
    beneath("appearance.mono-font", SettingsSection.APPEARANCE, Res.string.settings_appearance_mono_font, "monospaced font code terminal", "deng kuan zi ti dai ma zhong duan")
    beneath("appearance.background", SettingsSection.APPEARANCE, Res.string.settings_appearance_background, "background wallpaper texture", "bei jing bi zhi wen li")
    group("typography.preview", SettingsSection.TYPOGRAPHY, Res.string.settings_preview, "preview font", "yu lan")
    row("typography.size", SettingsSection.TYPOGRAPHY, Res.string.settings_text_size, "font text size scale 字号 字体 缩放", "wen zi da xiao zi hao")
    row("typography.spacing", SettingsSection.TYPOGRAPHY, Res.string.settings_session_spacing, "spacing density compact relaxed", "hui hua jian ju mi du")
    group("icons.app", SettingsSection.ICONS, Res.string.settings_app_icon, "launcher app icon", "ying yong tu biao")
    group("icons.pack", SettingsSection.ICONS, Res.string.settings_icon_pack, "icon pack lucide fluent mdi remix octicons", "jie mian tu biao tu biao bao")
    row("launch-tab.tab", SettingsSection.LAUNCH_TAB, Res.string.settings_launch_tab, "launch start tab assistant default open 启动 默认 打开 助理 标签", "qi dong mo ren da kai zhu li")
    row("input.running-message", SettingsSection.INTERACTION, Res.string.settings_task_output_to, "queue steer running message", "yun xing zhong fa song de xiao xi")
    group("input.verification", SettingsSection.INTERACTION, Res.string.settings_verify_group, "approval verification biometric fingerprint face security 指纹 人脸 生物识别", "shen pi yan zheng zhi wen ren lian an quan") { approvalVerificationAvailability() != VerificationAvailability.UNSUPPORTED }
    row("notifications.alerts", SettingsSection.NOTIFICATIONS, Res.string.settings_session_alerts, "session alerts notifications", "hui hua ti xing tong zhi") { NativeFeature.ALERTS.supported }
    row("notifications.permission", SettingsSection.NOTIFICATIONS, Res.string.settings_notification_permission, "notification permission", "xi tong tong zhi quan xian")
    row("notifications.watch", SettingsSection.NOTIFICATIONS, Res.string.settings_background_sessions, "background sessions keep alive", "hou tai gen jin yun xing zhong de hui hua") { NativeFeature.BACKGROUND_WATCH.supported }
    group("notifications.background", SettingsSection.NOTIFICATIONS, Res.string.settings_background, "background battery optimization keep alive auto start 电池 省电 自启动 保活", "hou tai yun xing dian chi zi qi dong")
    row("files.outside-read", SettingsSection.FILES, Res.string.settings_allow_outside_read, "outside directory read access", "yun xu du qu mu lu wai wen jian")
    group("files.editor", SettingsSection.FILES, Res.string.settings_editor, "editor command cursor vscode 命令", "bian ji qi ming ling")
    group("backends.agents", SettingsSection.BACKENDS, Res.string.settings_agent_backends, "agent backends provider cursor claude codex gemini", "dai li hou duan ti gong shang")
    row("backends.approval", SettingsSection.BACKENDS, Res.string.settings_approval_mode, "default approval permission sandbox", "mo ren shen pi mo shi")
    row("auxiliary.title", SettingsSection.AUXILIARY, Res.string.settings_auxiliary_title, "session title model", "hui hua biao ti")
    row("auxiliary.handoff", SettingsSection.AUXILIARY, Res.string.settings_auxiliary_handoff, "handoff summary model", "jiao jie zhai yao")
    row("assistant.supervision", SettingsSection.ASSISTANT, Res.string.assistant_supervision, "follow up tasks supervise background", "gen jin ren wu")
    row("assistant.consolidation", SettingsSection.ASSISTANT, Res.string.assistant_consolidation, "memory consolidation nightly", "ji yi zheng li")
    row("assistant.model", SettingsSection.ASSISTANT, Res.string.assistant_model, "assistant model agent provider", "zhu li mo xing")
    row("assistant.daily-runs", SettingsSection.ASSISTANT, Res.string.assistant_daily_runs, "daily runs limit budget per 24 hours", "24 xiao shi nei zui duo ci shu")
    row("assistant.dispatch", SettingsSection.ASSISTANT, Res.string.assistant_dispatch, "ask before starting a task approval", "kai shi ren wu qian xun wen")
    row("task-board.composer", SettingsSection.TASK_BOARD, Res.string.task_board_composer_sessions, "new session as task composer", "xin hui hua zuo wei ren wu")
    row("task-board.agent", SettingsSection.TASK_BOARD, Res.string.task_board_agent, "default agent", "mo ren agent")
    row("task-board.model", SettingsSection.TASK_BOARD, Res.string.task_board_model, "default model", "mo ren mo xing")
    row("quick-chat.model", SettingsSection.QUICK_CHAT, Res.string.settings_quick_chat_default_model, "quick chat default model", "kuai su dui hua mo ren mo xing")
    row("quick-chat.open-mode", SettingsSection.QUICK_CHAT, Res.string.settings_quick_chat_open_mode, "open mode sheet page", "da kai mo shi mian ban ye mian")
    row("quick-chat.presets", SettingsSection.QUICK_CHAT, Res.string.settings_quick_chat_presets, "quick chat presets prompts", "kuai su dui hua yu she ti shi ci")
    row("quick-chat.archive", SettingsSection.QUICK_CHAT, Res.string.settings_quick_chat_archive, "archive retention days 保留 天数", "gui dang bao liu tian shu")
    group("connection.servers", SettingsSection.CONNECTION, Res.string.settings_paired_servers, "paired servers connection switch", "yi pei dui fu wu qi lian jie")
    row("service.idle", SettingsSection.SERVICE, Res.string.settings_reclaim_idle, "idle reclaim stop cli", "kong xian hou ting zhi cli")
    row("service.limit", SettingsSection.SERVICE, Res.string.settings_reclaim_memory, "cli memory limit", "cli nei cun shang xian")
    group("service.latency", SettingsSection.SERVICE, Res.string.settings_service_requests_latency_chart, "request latency performance", "qing qiu yan chi")
    group("service.memory", SettingsSection.SERVICE, Res.string.settings_service_cpu_memory_chart, "cpu memory performance", "chu li qi nei cun")
    group("diagnostics.logs", SettingsSection.DIAGNOSTICS, Res.string.settings_diagnostics_logs, "logs export upload", "ri zhi dao chu shang chuan")
    row("diagnostics.upload", SettingsSection.DIAGNOSTICS, Res.string.settings_upload_logs, "upload logs", "shang chuan ri zhi")
    row("diagnostics.advanced", SettingsSection.DIAGNOSTICS, Res.string.settings_advanced_diagnostics, "advanced diagnostics terminal benchmark", "gao ji zhen duan zhong duan ji zhun")
    beneath("extensions.discovered", SettingsSection.EXTENSIONS, Res.string.settings_discovered_extensions, "discovered extensions plugins skills mcp hooks rules 插件 技能 规则", "fa xian de kuo zhan cha jian ji neng gui ze")
    beneath("extensions.manage", SettingsSection.EXTENSIONS, Res.string.settings_manage, "manage install plugins runtime check", "guan li an zhuang cha jian yun xing shi")
    group("devices.allow", SettingsSection.DEVICES, Res.string.settings_device_group, "allow device control", "she bei kong zhi")
}

internal data class SettingsSearchResult(val entry: SettingsSearchEntry, val title: String, val sectionTitle: String)
private fun String.searchText(): String = lowercase().filter { it.isLetterOrDigit() }

/** Resolving resource titles during composition keeps discovery in sync with the app language. */
@Composable
internal fun settingsSearchResults(query: String): List<SettingsSearchResult> {
    val resourcesAvailable = riffet.ui.theme.LocalAppearanceResources.current != null
    val resourceTargets = setOf("appearance.resources", "appearance.preset", "appearance.palette", "appearance.ui-font", "appearance.mono-font", "appearance.background")
    val resolved = settingsSearchCatalogue.filter { it.section.available && it.available() &&
        (it.id != "icons.app" || appIconSupported) && (resourcesAvailable || it.id !in resourceTargets) }.map { entry ->
        SettingsSearchResult(entry, stringResource(entry.title), entry.section.label)
    }
    val terms = query.trim().split(Regex("\\s+")).map(String::searchText).filter(String::isNotEmpty)
    if (terms.isEmpty()) return emptyList()
    return resolved.mapNotNull { result ->
        val title = result.title.searchText()
        val aliases = result.entry.aliases.searchText()
        val section = result.sectionTitle.searchText()
        if (!terms.all { title.contains(it) || aliases.contains(it) || section.contains(it) }) return@mapNotNull null
        val combined = terms.joinToString("")
        val rank = when {
            title == combined -> 0
            title.startsWith(combined) -> 1
            title.contains(combined) -> 2
            aliases.contains(combined) -> 3
            else -> 4
        }
        rank to result
    }.sortedBy { it.first }.map { it.second }
}

/** What the settings page's drawer search ([riffet.ui.app.PageSearch]) finds, in place of the sections. */
@Composable
internal fun SettingsSearchResults(query: String, onSelect: (SettingsSearchEntry) -> Unit) {
    val metrics = LocalInterfaceStyle.current.metrics
    val colors = LocalRiffetColors.current
    if (query.isNotBlank()) {
        val results = settingsSearchResults(query)
        if (results.isEmpty()) Text(stringResource(Res.string.settings_search_empty), style = LocalRiffetTypography.current.body,
            color = colors.fg3, modifier = Modifier.padding(vertical = metrics.sectionGap))
        else SettingsGroup("") {
            results.forEach { result ->
                SettingsLinkRow(result.title, result.sectionTitle.takeIf { it != result.title }, leading = {
                    Icon(result.entry.section.icon, null, Modifier.size(metrics.iconSize), colors.fg2)
                }) { onSelect(result.entry) }
            }
        }
    }
}

/** Shared settings adapters expose anchors without adding keyboard focus stops or invoking controls. */
@Composable
internal fun Modifier.settingsSearchAnchor(title: String, anchor: SettingsSearchAnchor = SettingsSearchAnchor.ROW): Modifier {
    val target = LocalSettingsSearchTarget.current
    if (target == null || target.title != title || target.anchor != anchor) return this
    val requester = remember(target.id) { BringIntoViewRequester() }
    var size by remember(target.id) { mutableStateOf(IntSize.Zero) }
    var highlighted by remember(target.id) { mutableStateOf(false) }
    var located by remember(target.id) { mutableStateOf(false) }
    val pageActive = LocalPageActive.current
    val metrics = LocalInterfaceStyle.current.metrics
    val groupContext = with(LocalDensity.current) { if (anchor == SettingsSearchAnchor.GROUP) (metrics.rowHeight * 2).toPx() else 0f }
    LaunchedEffect(target.id, size, pageActive) {
        if (size != IntSize.Zero && pageActive && !located) {
            withFrameNanos { }
            requester.bringIntoView(Rect(0f, 0f, size.width.toFloat(), size.height + groupContext))
            located = true
            highlighted = true
            try { delay(2200) } finally { highlighted = false }
        }
    }
    val colors = LocalRiffetColors.current
    return then(Modifier.bringIntoViewRequester(requester).onGloballyPositioned { size = it.size }
        .then(if (highlighted) Modifier.background(colors.accent.copy(alpha = 0.12f), RoundedCornerShape(metrics.controlRadius)) else Modifier))
}
