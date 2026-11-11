package riffet.android

import android.app.KeyguardManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.os.SystemClock
import android.util.Base64
import android.view.accessibility.AccessibilityNodeInfo
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import riffet.contracts.DeviceCall
import riffet.contracts.DeviceCallOutcome
import riffet.contracts.DeviceCapability
import riffet.contracts.DeviceErrorCode
import riffet.contracts.DeviceFileUpload
import riffet.shared.AppLog
import riffet.shared.AppPolicy
import riffet.shared.DeviceControl
import riffet.shared.DeviceGrants
import riffet.shared.DeviceStop
import riffet.shared.RiskCategory
import riffet.shared.RiskClassifier
import riffet.shared.ScreenEffect
import riffet.shared.ScreenElement
import riffet.shared.ScreenRefs
import riffet.shared.ScreenSnapshot
import riffet.shared.StepDecision
import riffet.shared.RiffetApi
import riffet.shared.createAppPreferences
import riffet.shared.decideStep
import riffet.shared.pixel
import riffet.shared.uploadDeviceCallFile
import java.io.ByteArrayOutputStream
import java.time.Instant

/**
 * ActionGate (docs/DEVICES.md §5): the only way a call reaches the screen. Every step goes guard →
 * risk → authorisation → execute → verify, and its outcome (target, category, who authorised it)
 * goes back in the result, which the server records. The accessibility service's gestures and node
 * actions are called from nowhere else. [DeviceGate][riffet.shared.DeviceGate] in front of it has
 * already checked the switch, the capability, the stop and the lock.
 */
internal class ScreenActionGate(private val rawContext: Context) {
    private val context get() = riffet.shared.AppLanguages.localize(rawContext)
    /** One conversation's refs per session, a few sessions at a time. */
    private val sessions = object : LinkedHashMap<String, ScreenRefs>(8, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, ScreenRefs>?) = size > MAX_SESSIONS
    }
    private val lock = Mutex()
    private val grants by lazy { DeviceGrants(createAppPreferences()) }
    private val policies get() = DeviceControl.apps

    /** The last text typed and where: what a later tap on 发送 sends. */
    private var lastTyped: Triple<String?, String, Long>? = null

    fun capabilities(): List<String> = if (AccessibilityControl.reachable(context)) DeviceCapability.T1 else emptyList()

    fun locked(): Boolean {
        val keyguard = context.getSystemService(KeyguardManager::class.java)
        val power = context.getSystemService(PowerManager::class.java)
        return keyguard?.isKeyguardLocked == true || power?.isInteractive == false
    }

    suspend fun execute(call: DeviceCall, api: RiffetApi): DeviceCallOutcome = lock.withLock {
        val service = RiffetAccessibilityService.instance.value
            ?: return DeviceCallOutcome.failure(DeviceErrorCode.CAPABILITY_MISSING, "The accessibility service is off on this device")
        val refs = synchronized(sessions) { sessions.getOrPut(call.sessionId) { ScreenRefs() } }
        when (call.capability) {
            DeviceCapability.SCREEN_OBSERVE -> observe(service, refs, call, api)
            DeviceCapability.SCREEN_ACT -> (call.args["authorize"] as? JsonObject)?.let { authorize(call, it) }
                ?: controlled { act(service, refs, call) }
            DeviceCapability.APP_LAUNCH -> if (call.bool("list") == true) listApps(call.string("query")) else controlled { launch(service, call) }
            else -> DeviceCallOutcome.failure(DeviceErrorCode.CAPABILITY_MISSING, "${call.capability} is not a screen capability")
        }
    }

    // ---- Observe -------------------------------------------------------------------------------

    private suspend fun observe(service: RiffetAccessibilityService, refs: ScreenRefs, call: DeviceCall, api: RiffetApi): DeviceCallOutcome {
        val (snapshot, blocked) = read(service, refs)
        snapshot.foreground?.let(::touch)
        if (blocked) {
            refs.withheld()
            return DeviceCallOutcome.success(buildJsonObject {
                put("untrusted", true)
                put("blocked", true)
                snapshot.foreground?.let { put("package", it); appLabel(it)?.let { label -> put("app", label) } }
            })
        }
        var fileId: String? = null
        var secure = false
        var shotError: String? = null
        if (call.bool("includeScreenshot") == true) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
                shotError = "Screenshots need Android 11 or later"
            } else {
                when (val shot = service.screenshot()) {
                    is RiffetAccessibilityService.Shot.Ok -> {
                        if (nearlyBlack(shot.bitmap)) secure = true
                        else fileId = api.uploadDeviceCallFile(call.callId, withContext(Dispatchers.Default) { jpeg(shot.bitmap) }).fileId
                        shot.bitmap.recycle()
                    }
                    RiffetAccessibilityService.Shot.Secure -> secure = true
                    is RiffetAccessibilityService.Shot.Failed -> shotError = shot.message
                }
            }
        }
        val observation = refs.observe(snapshot, call.string("since")) {
            snapshot.foreground?.let(::appLabel)?.let { put("app", it) }
            if (secure) put("secure", true)
            shotError?.let { put("screenshotError", it) }
            fileId?.let { put("fileIds", buildJsonArray { add(JsonPrimitive(it)) }) }
        }
        return DeviceCallOutcome.success(observation)
    }

    /** A read with the windows of blocked apps behind the front one left out; `blocked` when the app in front is one, whose nodes are then never sent. */
    private fun read(service: RiffetAccessibilityService, refs: ScreenRefs): Pair<ScreenSnapshot, Boolean> {
        val raw = AndroidScreen.read(service)
        val foreground = raw.windows.firstOrNull { it.type == "app" && it.active }?.packageName ?: raw.windows.firstOrNull { it.type == "app" }?.packageName
        // Other blocked apps' windows are left out; the app in front stays, so steps judge the real foreground.
        val visible = raw.copy(windows = raw.windows.filter { it.packageName == foreground || it.type == "ime" || policies.policy(it.packageName) != AppPolicy.BLOCK })
        return refs.snapshot(visible) to (policies.policy(foreground) == AppPolicy.BLOCK)
    }

    private fun nearlyBlack(bitmap: Bitmap): Boolean {
        for (i in 0 until 10) for (j in 0 until 10) {
            val pixel = bitmap.getPixel((bitmap.width - 1) * i / 9, (bitmap.height - 1) * j / 9)
            if (((pixel shr 16) and 0xff) + ((pixel shr 8) and 0xff) + (pixel and 0xff) > 24) return false
        }
        return true
    }

    private fun jpeg(bitmap: Bitmap): DeviceFileUpload {
        val scale = minOf(1f, SHOT_EDGE.toFloat() / maxOf(bitmap.width, bitmap.height))
        val scaled = if (scale < 1f) Bitmap.createScaledBitmap(bitmap, (bitmap.width * scale).toInt(), (bitmap.height * scale).toInt(), true) else bitmap
        val out = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, 80, out)
        val upload = DeviceFileUpload("screen-${System.currentTimeMillis()}.jpg", "image/jpeg", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP), scaled.width, scaled.height)
        if (scaled !== bitmap) scaled.recycle()
        return upload
    }

    // ---- Act -----------------------------------------------------------------------------------

    private class Step(val action: String, val ref: String?, val x: Int?, val y: Int?, val text: String?, val submit: Boolean, val direction: String?, val timeoutMs: Int?)

    private class StepOutcome(val json: JsonObject, val ok: Boolean, val after: ScreenSnapshot?)

    /** What the steps did so far; an owner's stop answers with these. */
    private class Progress(var package_: String? = null) {
        val results = mutableListOf<JsonObject>()
    }

    private suspend fun act(service: RiffetAccessibilityService, refs: ScreenRefs, call: DeviceCall): DeviceCallOutcome {
        val raw = call.args["steps"] as? JsonArray ?: return invalid("steps is required")
        val steps = raw.mapNotNull { it as? JsonObject }.map { o ->
            Step(
                action = o.string("action") ?: "", ref = o.string("ref"), x = o.int("x"), y = o.int("y"),
                text = (o["text"] as? JsonPrimitive)?.contentOrNull, submit = o.bool("submit") == true,
                direction = o.string("direction"), timeoutMs = o.int("timeoutMs"),
            )
        }
        if (steps.isEmpty() || steps.size > MAX_STEPS) return invalid("steps must list 1 to $MAX_STEPS steps")
        val since = refs.sentId
        val progress = Progress()
        var before = read(service, refs).first
        progress.package_ = before.foreground
        var stoppedAt: Int? = null
        val stopped = stoppable {
            for ((index, step) in steps.withIndex()) {
                val outcome = try {
                    step(service, refs, call, index, step, before)
                } catch (cancellation: CancellationException) {
                    throw cancellation
                } catch (failure: Throwable) {
                    StepOutcome(failed(step.action, DeviceErrorCode.FAILED, failure.message ?: failure::class.simpleName), false, null)
                }
                progress.results += outcome.json
                before = outcome.after ?: before
                progress.package_ = before.foreground
                before.foreground?.let(::touch)
                if (!outcome.ok) {
                    stoppedAt = index
                    break
                }
            }
        }
        if (stopped) {
            stoppedAt = progress.results.size
            progress.results += failed(steps.getOrNull(progress.results.size)?.action ?: "", DeviceErrorCode.STOPPED, "The owner pressed stop on the device")
        }
        val observation = if (call.bool("observe") == true && !stopped) {
            val (fresh, blocked) = read(service, refs)
            if (blocked) null else refs.observe(fresh, since) { fresh.foreground?.let(::appLabel)?.let { put("app", it) } }
        } else {
            null
        }
        return DeviceCallOutcome.success(buildJsonObject {
            put("untrusted", true)
            progress.package_?.let { put("package", it) }
            observation?.get("snapshotId")?.let { put("snapshotId", it) }
            put("steps", JsonArray(progress.results))
            stoppedAt?.let { put("stoppedAt", it) }
            observation?.let { put("observation", it) }
        })
    }

    private suspend fun step(service: RiffetAccessibilityService, refs: ScreenRefs, call: DeviceCall, index: Int, step: Step, before: ScreenSnapshot): StepOutcome {
        val pkg = before.foreground
        val policy = policies.policy(pkg)
        val modifying = step.action in setOf("tap", "long_press", "type", "swipe", "scroll")
        if (modifying && policy == AppPolicy.BLOCK) {
            return StepOutcome(failed(step.action, DeviceErrorCode.NOT_ALLOWED, "The owner blocks control of ${pkg?.let(::appLabel) ?: pkg} on this device"), false, null)
        }
        return when (step.action) {
            "back", "home" -> {
                service.performGlobalAction(if (step.action == "back") android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK else android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_HOME)
                settled(service, refs, step.action, before)
            }
            "wait_stable" -> {
                val stable = waitQuiet(QUIET_MILLIS, (step.timeoutMs ?: 3000).coerceIn(0, 10_000).toLong())
                val after = read(service, refs).first
                StepOutcome(ok(step.action) { put("effect", ScreenEffect.of(before, after)); if (!stable) put("stable", false) }, true, after)
            }
            "tap", "long_press" -> tap(service, refs, call, index, step, before)
            "type" -> type(service, refs, call, index, step, before)
            "swipe", "scroll" -> move(service, refs, step, before)
            else -> StepOutcome(failed(step.action, DeviceErrorCode.FAILED, "Unknown action ${step.action}"), false, null)
        }
    }

    /** The element a step names: its ref, checked against what the agent last saw there, or the point. */
    private fun target(refs: ScreenRefs, step: Step, screen: ScreenSnapshot): Result<ScreenElement?> {
        val ref = step.ref
        if (ref != null) {
            val element = screen.byRef[ref] ?: return Result.failure(IllegalStateException("$ref is no longer on screen; observe again"))
            val seen = refs.sent?.byRef?.get(ref)
            if (seen != null && !element.editable && seen.label != element.label) {
                return Result.failure(IllegalStateException("$ref now shows \"${element.label.take(40)}\" (was \"${seen.label.take(40)}\"); observe again"))
            }
            return Result.success(element)
        }
        val x = step.x ?: return Result.failure(IllegalArgumentException("Give ref or x, y"))
        val y = step.y ?: return Result.failure(IllegalArgumentException("Give ref or x, y"))
        return Result.success(screen.at(x, y))
    }

    private suspend fun tap(service: RiffetAccessibilityService, refs: ScreenRefs, call: DeviceCall, index: Int, step: Step, before: ScreenSnapshot): StepOutcome {
        val long = step.action == "long_press"
        val element = target(refs, step, before).getOrElse { return StepOutcome(failed(step.action, DeviceErrorCode.FAILED, it.message), false, null) }
        val label = element?.let { it.label.ifEmpty { before.innerText(it) } }?.takeIf { it.isNotBlank() }?.take(80)
        // A long press opens menus; what it would do is decided by the tap that follows.
        val category = if (long || element == null) null else RiskClassifier.ofTap(element, before)
        val content = if (category == RiskCategory.SEND) composed(before) else null
        val gate = authorize(call, index, step.action, before.foreground, category, label, content)
        if (gate.failure != null) return StepOutcome(gate.failure, false, null)
        // Asking the owner covered the screen: find the target again once the app is back.
        var screen = before
        var current = element
        if (gate.asked) {
            screen = backTo(service, refs, before.foreground)
            if (screen.foreground != before.foreground) return StepOutcome(failed(step.action, DeviceErrorCode.FAILED, "${before.foreground} is no longer in front after the confirmation", label, category), false, screen)
            if (step.ref != null) current = target(refs, step, screen).getOrElse { return StepOutcome(failed(step.action, DeviceErrorCode.FAILED, it.message, label, category), false, screen) }
        }
        val done = if (current != null && step.x == null && click(current, long)) {
            true
        } else {
            val (gx, gy) = if (step.x != null && step.y != null) step.x to step.y else current!!.centerX to current.centerY
            service.tap(pixel(gx, screen.width).toFloat(), pixel(gy, screen.height).toFloat(), if (long) LONG_PRESS_MILLIS else TAP_MILLIS)
        }
        if (!done) return StepOutcome(failed(step.action, DeviceErrorCode.FAILED, "The system did not deliver the tap", label, category), false, null)
        return settled(service, refs, step.action, screen) {
            label?.let { put("target", it) }
            category?.let { put("category", it.wire) }
            gate.authorizedBy?.let { put("authorizedBy", it) }
        }
    }

    private suspend fun type(service: RiffetAccessibilityService, refs: ScreenRefs, call: DeviceCall, index: Int, step: Step, before: ScreenSnapshot): StepOutcome {
        val text = step.text ?: return StepOutcome(failed("type", DeviceErrorCode.FAILED, "text is required"), false, null)
        val field = if (step.ref != null) {
            target(refs, step, before).getOrElse { return StepOutcome(failed("type", DeviceErrorCode.FAILED, it.message), false, null) }
        } else {
            before.elements.firstOrNull { it.editable && it.node.focused }
        } ?: return StepOutcome(failed("type", DeviceErrorCode.FAILED, "No field has the input focus; give its ref"), false, null)
        if (!field.editable) return StepOutcome(failed("type", DeviceErrorCode.FAILED, "${field.ref} is not a text field"), false, null)
        val node = field.node.handle as AccessibilityNodeInfo
        if (!node.isFocused) node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        val set = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) })
        if (!set && !paste(node, text)) return StepOutcome(failed("type", DeviceErrorCode.FAILED, "The field did not accept text"), false, null)
        delay(READBACK_MILLIS)
        val verified = when {
            node.isPassword -> "unknown"
            !node.refresh() -> "unknown"
            node.text?.toString()?.trim() == text.trim() && !node.isShowingHintText -> "match"
            else -> "mismatch"
        }
        lastTyped = Triple(before.foreground, text, SystemClock.uptimeMillis())
        var authorizedBy: String? = null
        var category: RiskCategory? = null
        if (step.submit) {
            category = RiskClassifier.ofSubmit(field)
            val gate = authorize(call, index, "type", before.foreground, category, field.hint ?: field.label.ifEmpty { null }, text)
            if (gate.failure != null) return StepOutcome(gate.failure, false, null)
            authorizedBy = gate.authorizedBy
            if (gate.asked) backTo(service, refs, before.foreground)
            node.refresh()
            val enter = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
                node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
            if (!enter) return StepOutcome(failed("type", DeviceErrorCode.FAILED, "The field has no enter action here; tap the send button instead", category = category), false, null)
        }
        return settled(service, refs, "type", before) {
            put("verified", verified)
            category?.let { put("category", it.wire) }
            authorizedBy?.let { put("authorizedBy", it) }
        }
    }

    private fun paste(node: AccessibilityNodeInfo, text: String): Boolean {
        context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("Riffet", text)) ?: return false
        val length = node.text?.length ?: 0
        node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, 0)
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, length)
        })
        return node.performAction(AccessibilityNodeInfo.ACTION_PASTE)
    }

    private suspend fun move(service: RiffetAccessibilityService, refs: ScreenRefs, step: Step, before: ScreenSnapshot): StepOutcome {
        val direction = step.direction?.takeIf { it in setOf("up", "down", "left", "right") }
            ?: return StepOutcome(failed(step.action, DeviceErrorCode.FAILED, "direction must be up, down, left or right"), false, null)
        val area = if (step.ref != null) {
            target(refs, step, before).getOrElse { return StepOutcome(failed(step.action, DeviceErrorCode.FAILED, it.message), false, null) }
        } else if (step.action == "scroll") {
            before.elements.filter { it.scrollable }.maxByOrNull { (it.bounds[2] - it.bounds[0]) * (it.bounds[3] - it.bounds[1]) }
        } else {
            null
        }
        if (step.action == "scroll" && area != null && scrollAction(area, direction)) return settled(service, refs, step.action, before)
        // A finger moves against the content: to see what is below, swipe up.
        val finger = if (step.action == "scroll") opposite(direction) else direction
        val bounds = area?.bounds ?: listOf(100, 250, 899, 749)
        val cx = (bounds[0] + bounds[2]) / 2
        val cy = (bounds[1] + bounds[3]) / 2
        val dx = (bounds[2] - bounds[0]) * 3 / 10
        val dy = (bounds[3] - bounds[1]) * 3 / 10
        val (from, to) = when (finger) {
            "up" -> (cx to cy + dy) to (cx to cy - dy)
            "down" -> (cx to cy - dy) to (cx to cy + dy)
            "left" -> (cx + dx to cy) to (cx - dx to cy)
            else -> (cx - dx to cy) to (cx + dx to cy)
        }
        val w = before.width
        val h = before.height
        val done = service.swipe(pixel(from.first, w).toFloat(), pixel(from.second, h).toFloat(), pixel(to.first, w).toFloat(), pixel(to.second, h).toFloat(), SWIPE_MILLIS)
        if (!done) return StepOutcome(failed(step.action, DeviceErrorCode.FAILED, "The system did not deliver the swipe"), false, null)
        return settled(service, refs, step.action, before)
    }

    private fun scrollAction(element: ScreenElement, direction: String): Boolean {
        val node = element.node.handle as? AccessibilityNodeInfo ?: return false
        val directional = when (direction) {
            "down" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN
            "up" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP
            "left" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT
            else -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT
        }
        if (node.actionList.any { it.id == directional.id } && node.performAction(directional.id)) return true
        val generic = if (direction == "down" || direction == "right") AccessibilityNodeInfo.ACTION_SCROLL_FORWARD else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
        return node.performAction(generic)
    }

    private fun opposite(direction: String) = when (direction) {
        "up" -> "down"
        "down" -> "up"
        "left" -> "right"
        else -> "left"
    }

    /** The node's own click, or its nearest clickable ancestor's; false leaves it to a gesture. */
    private fun click(element: ScreenElement, long: Boolean): Boolean {
        var node = element.node.handle as? AccessibilityNodeInfo
        var depth = 0
        while (node != null && depth < 6) {
            if (if (long) node.isLongClickable else node.isClickable) {
                return node.performAction(if (long) AccessibilityNodeInfo.ACTION_LONG_CLICK else AccessibilityNodeInfo.ACTION_CLICK)
            }
            node = node.parent
            depth++
        }
        return false
    }

    /** What a send would send: the text just typed here if the field still holds it, else the focused field's. */
    private fun composed(screen: ScreenSnapshot): String? {
        lastTyped?.let { (pkg, text, at) ->
            if (pkg == screen.foreground && SystemClock.uptimeMillis() - at < TYPED_MEMORY_MILLIS &&
                screen.elements.any { it.editable && it.text?.trim() == text.trim() }
            ) return text
        }
        val fields = screen.elements.filter { it.editable && !it.secret && it.text != null && it.packageName == screen.foreground }
        return (fields.firstOrNull { it.node.focused } ?: fields.lastOrNull())?.text
    }

    private suspend fun settled(service: RiffetAccessibilityService, refs: ScreenRefs, action: String, before: ScreenSnapshot, extra: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit = {}): StepOutcome {
        delay(EVENT_LAG_MILLIS)
        waitQuiet(SETTLE_QUIET_MILLIS, SETTLE_MAX_MILLIS)
        val after = read(service, refs).first
        return StepOutcome(ok(action) { put("effect", ScreenEffect.of(before, after)); extra() }, true, after)
    }

    private suspend fun waitQuiet(quietMillis: Long, maxMillis: Long): Boolean {
        val end = SystemClock.uptimeMillis() + maxMillis
        while (true) {
            val now = SystemClock.uptimeMillis()
            if (now - RiffetAccessibilityService.lastEventAt >= quietMillis) return true
            if (now >= end) return false
            delay(POLL_MILLIS)
        }
    }

    /** After the confirmation sheet closes: wait for [pkg] to be in front again. */
    private suspend fun backTo(service: RiffetAccessibilityService, refs: ScreenRefs, pkg: String?): ScreenSnapshot {
        val end = SystemClock.uptimeMillis() + RETURN_MILLIS
        var screen = read(service, refs).first
        while (screen.foreground != pkg && SystemClock.uptimeMillis() < end) {
            delay(150)
            screen = read(service, refs).first
        }
        waitQuiet(SETTLE_QUIET_MILLIS, SETTLE_MAX_MILLIS)
        return read(service, refs).first
    }

    // ---- Authorisation -------------------------------------------------------------------------

    private class Gate(val authorizedBy: String? = null, val asked: Boolean = false, val failure: JsonObject? = null)

    /** Risk → authorisation for one step: the device's own rules, then the owner when they are needed. */
    private suspend fun authorize(call: DeviceCall, index: Int, action: String, pkg: String?, category: RiskCategory?, target: String?, content: String?): Gate {
        val policy = policies.policy(pkg)
        return when (val decision = decideStep(policy, category) { pkg?.let { grants.consume(it, category!!, content) } }) {
            is StepDecision.Allow -> Gate(decision.authorizedBy)
            StepDecision.Block -> Gate(failure = failed(action, DeviceErrorCode.NOT_ALLOWED, "The owner blocks control of this app", target, category))
            StepDecision.Handoff -> {
                DeviceNotices.handoff(context, pkg, pkg?.let(::appLabel), target)
                Gate(failure = failed(action, DeviceErrorCode.HANDOFF_REQUIRED, "Paying is done by the owner only. The phone notified them; tell the user what is left to pay and stop here.", target, category))
            }
            StepDecision.Ask -> {
                val request = ConfirmRequest(category!!, pkg, pkg?.let(::appLabel) ?: pkg, target, content, summary = null, validMinutes = null)
                val answer = RiffetAccessibilityService.ownerTurn {
                    DeviceRequests.await(context, "${call.callId}/$index", DeviceAction.Confirm(request), request.title(context), request.app, timeLeft(call), direct = true)
                }
                when (answer) {
                    is DeviceActionResult.Done -> Gate("owner", asked = true)
                    DeviceActionResult.Denied -> Gate(failure = failed(action, DeviceErrorCode.DENIED, "The owner declined on the device", target, category))
                    is DeviceActionResult.Failed -> Gate(failure = failed(action, DeviceErrorCode.FAILED, answer.message, target, category))
                }
            }
        }
    }

    /** `device_authorize`: the owner confirms now, the grant covers a later step. */
    private suspend fun authorize(call: DeviceCall, args: JsonObject): DeviceCallOutcome {
        val pkg = args.string("app") ?: return invalid("app is required")
        val category = RiskCategory.of(args.string("action"))?.takeIf { it.grantable } ?: return invalid("action must be send, delete or submit")
        val summary = args.string("summary") ?: return invalid("summary is required")
        val minutes = args.int("validMinutes")?.takeIf { it in 1..1440 } ?: return invalid("validMinutes must be 1 to 1440")
        val content = (args["content"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
        val label = appLabel(pkg) ?: return invalid("$pkg is not installed on this device")
        if (policies.policy(pkg) == AppPolicy.BLOCK) return DeviceCallOutcome.failure(DeviceErrorCode.NOT_ALLOWED, "The owner blocks control of $label on this device")
        val request = ConfirmRequest(category, pkg, label, target = null, content = content, summary = summary.take(300), validMinutes = minutes)
        return when (val answer = DeviceRequests.await(context, call.callId, DeviceAction.Confirm(request), request.title(context), label, timeLeft(call), direct = true)) {
            is DeviceActionResult.Done -> {
                val grant = grants.add(pkg, category, summary, content, minutes)
                touch(pkg)
                DeviceCallOutcome.success(buildJsonObject {
                    put("grantId", grant.id)
                    put("app", pkg)
                    put("action", category.wire)
                    put("expiresAt", Instant.ofEpochMilli(grant.expiresAt).toString())
                })
            }
            DeviceActionResult.Denied -> DeviceCallOutcome.failure(DeviceErrorCode.DENIED, "The owner declined on the device")
            is DeviceActionResult.Failed -> DeviceCallOutcome.failure(DeviceErrorCode.FAILED, answer.message)
        }
    }

    // ---- Apps ----------------------------------------------------------------------------------

    private suspend fun launch(service: RiffetAccessibilityService, call: DeviceCall): DeviceCallOutcome {
        val apps = launchable()
        val name = call.string("name")
        val pkg = call.string("package")
            ?: name?.let { n -> (apps.firstOrNull { it.second.equals(n, ignoreCase = true) } ?: apps.firstOrNull { it.second.contains(n, ignoreCase = true) })?.first }
            ?: return invalid(if (name != null) "No app named $name; list the apps" else "package or name is required")
        if (policies.policy(pkg) == AppPolicy.BLOCK) return DeviceCallOutcome.failure(DeviceErrorCode.NOT_ALLOWED, "The owner blocks control of ${appLabel(pkg) ?: pkg} on this device")
        val intent = context.packageManager.getLaunchIntentForPackage(pkg)?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            ?: return invalid("$pkg is not installed or cannot be opened")
        // A bound accessibility service may start activities from the background.
        withContext(Dispatchers.Main) { service.startActivity(intent) }
        val end = SystemClock.uptimeMillis() + LAUNCH_MILLIS
        var front = false
        while (SystemClock.uptimeMillis() < end) {
            delay(200)
            if (service.rootInActiveWindow?.packageName?.toString() == pkg) {
                front = true
                break
            }
        }
        if (front) waitQuiet(SETTLE_QUIET_MILLIS, SETTLE_MAX_MILLIS)
        // An app that shows for a moment and closes again (or a chooser such as a dual-app picker in
        // front of it) is not in front: judge after settling, and say what is.
        val actual = service.rootInActiveWindow?.packageName?.toString()
        front = actual == pkg
        val label = appLabel(pkg) ?: pkg
        touch(pkg)
        return DeviceCallOutcome.success(buildJsonObject {
            put("package", pkg)
            put("app", label)
            put("foreground", front)
            if (!front && actual != null) {
                put("frontPackage", actual)
                appLabel(actual)?.let { put("frontApp", it) }
            }
        })
    }

    private fun listApps(query: String?): DeviceCallOutcome {
        val apps = launchable().filter { (pkg, label) -> query == null || label.contains(query, true) || pkg.contains(query, true) }.take(MAX_APPS)
        return DeviceCallOutcome.success(buildJsonObject {
            put("apps", buildJsonArray {
                for ((pkg, label) in apps) add(buildJsonObject {
                    put("package", pkg)
                    put("app", label)
                    if (policies.policy(pkg) == AppPolicy.BLOCK) put("blocked", true)
                })
            })
        })
    }

    /** Launcher apps as (package, label), by label. */
    private fun launchable(): List<Pair<String, String>> {
        val pm = context.packageManager
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        @Suppress("DEPRECATION")
        return pm.queryIntentActivities(intent, 0).map { it.activityInfo.packageName to it.loadLabel(pm).toString() }
            .filter { it.first != context.packageName }.distinctBy { it.first }.sortedBy { it.second.lowercase() }
    }

    private fun appLabel(pkg: String): String? = runCatching {
        val pm = context.packageManager
        @Suppress("DEPRECATION")
        pm.getApplicationInfo(pkg, 0).loadLabel(pm).toString()
    }.getOrNull()

    /** Apps the agent worked in, for the settings list; the launcher and Riffet itself are left out. */
    private fun touch(pkg: String) {
        if (pkg == context.packageName || context.packageManager.getLaunchIntentForPackage(pkg) == null) return
        appLabel(pkg)?.let { policies.touch(pkg, it) }
    }

    // ---- Stop ----------------------------------------------------------------------------------

    /**
     * Runs a control call with the ongoing 停止 notification up. The owner touching the screen
     * meanwhile counts as 停止: they took over.
     */
    private suspend fun controlled(block: suspend () -> DeviceCallOutcome): DeviceCallOutcome {
        DeviceNotices.controlStarted(context)
        val unwatch = RiffetAccessibilityService.instance.value?.watchTouches {
            AppLog.log("device", "the owner touched the screen")
            DeviceStop.stop()
        }
        try {
            return block()
        } finally {
            unwatch?.invoke()
            DeviceNotices.controlEnded(context)
        }
    }

    /** True when the owner's stop cut [block] short. */
    private suspend fun stoppable(block: suspend () -> Unit): Boolean = coroutineScope {
        val started = System.currentTimeMillis()
        val work = async { block() }
        val watcher = launch { DeviceStop.until.first { it > started + 1 && DeviceStop.active() } ; work.cancel() }
        try {
            work.await()
            false
        } catch (cancellation: CancellationException) {
            if (!DeviceStop.active()) throw cancellation
            AppLog.log("device", "control stopped by the owner")
            true
        } finally {
            watcher.cancel()
        }
    }

    private fun timeLeft(call: DeviceCall): Long? = runCatching { Instant.parse(call.deadline).toEpochMilli() - System.currentTimeMillis() }.getOrNull()

    private fun invalid(message: String) = DeviceCallOutcome.failure(DeviceErrorCode.FAILED, message)

    private fun ok(action: String, extra: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit = {}) = buildJsonObject {
        put("action", action)
        put("ok", true)
        extra()
    }

    private fun failed(action: String, code: String, message: String?, target: String? = null, category: RiskCategory? = null) = buildJsonObject {
        put("action", action)
        put("ok", false)
        put("code", code)
        message?.let { put("message", it) }
        target?.let { put("target", it) }
        category?.let { put("category", it.wire) }
    }

    private companion object {
        const val MAX_SESSIONS = 8
        const val MAX_STEPS = 20
        const val MAX_APPS = 300
        const val SHOT_EDGE = 1280
        const val TAP_MILLIS = 60L
        const val LONG_PRESS_MILLIS = 700L
        const val SWIPE_MILLIS = 350L
        const val QUIET_MILLIS = 500L
        const val SETTLE_QUIET_MILLIS = 300L
        const val SETTLE_MAX_MILLIS = 1500L
        const val EVENT_LAG_MILLIS = 120L
        const val POLL_MILLIS = 50L
        const val READBACK_MILLIS = 150L
        const val RETURN_MILLIS = 3000L
        const val LAUNCH_MILLIS = 5000L
        const val TYPED_MEMORY_MILLIS = 10 * 60_000L
    }
}

private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }
private fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.intOrNull
private fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull
private fun DeviceCall.string(key: String) = args.string(key)
private fun DeviceCall.bool(key: String) = args.bool(key)

/** What the confirmation sheet shows. [summary] and [validMinutes] are set for a pre-authorisation. */
internal data class ConfirmRequest(
    val category: RiskCategory,
    val packageName: String?,
    val app: String?,
    val target: String?,
    val content: String?,
    val summary: String?,
    val validMinutes: Int?,
) {
    val grant: Boolean get() = validMinutes != null

    fun title(context: Context): String = riffet.shared.AppLanguages.localize(context).getString(
        when (category) {
            RiskCategory.SEND -> if (grant) riffet.shared.R.string.host_device_grant_send else riffet.shared.R.string.host_device_confirm_send
            RiskCategory.DELETE -> if (grant) riffet.shared.R.string.host_device_grant_delete else riffet.shared.R.string.host_device_confirm_delete
            RiskCategory.SUBMIT -> if (grant) riffet.shared.R.string.host_device_grant_submit else riffet.shared.R.string.host_device_confirm_submit
            RiskCategory.ORDER, RiskCategory.PAY -> riffet.shared.R.string.host_device_confirm_order
        },
    )
}
