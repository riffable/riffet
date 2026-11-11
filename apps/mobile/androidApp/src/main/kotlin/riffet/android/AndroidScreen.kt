package riffet.android

import android.graphics.Rect
import android.os.Build
import android.util.DisplayMetrics
import android.view.WindowManager
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import riffet.shared.ScreenNode
import riffet.shared.ScreenRead
import riffet.shared.ScreenWindow

/** Reads the main display's windows (`getWindows` lists only those) into [ScreenRead]; each node keeps its [AccessibilityNodeInfo] as the handle. */
internal object AndroidScreen {
    private const val MAX_NODES = 4000
    private const val MAX_DEPTH = 80

    fun read(service: RiffetAccessibilityService): ScreenRead {
        val (width, height) = size(service)
        val own = service.packageName
        val windows = runCatching { service.windows }.getOrNull().orEmpty()
            .sortedByDescending { it.layer }
            .mapNotNull { window ->
                val root = runCatching { window.root }.getOrNull()
                val packageName = root?.packageName?.toString()
                // Our own accessibility overlays are not part of what the owner sees as the screen.
                if (window.type == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY && packageName == own) return@mapNotNull null
                val budget = intArrayOf(MAX_NODES)
                ScreenWindow(
                    id = window.id,
                    type = type(window.type),
                    packageName = packageName,
                    title = window.title?.toString(),
                    active = window.isActive,
                    root = root?.let { node(it, budget, 0) },
                )
            }
        // No window list (the flag was refused): the active window alone.
        if (windows.isEmpty()) {
            val root = service.rootInActiveWindow ?: return ScreenRead(emptyList(), width, height)
            return ScreenRead(listOf(ScreenWindow(root.windowId, "app", root.packageName?.toString(), null, true, node(root, intArrayOf(MAX_NODES), 0))), width, height)
        }
        return ScreenRead(windows, width, height)
    }

    private fun type(type: Int) = when (type) {
        AccessibilityWindowInfo.TYPE_APPLICATION -> "app"
        AccessibilityWindowInfo.TYPE_INPUT_METHOD -> "ime"
        AccessibilityWindowInfo.TYPE_SYSTEM -> "system"
        AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY -> "overlay"
        else -> "other"
    }

    @Suppress("DEPRECATION") // isChecked: the tri-state replacement is API 36 only.
    private fun node(info: AccessibilityNodeInfo, budget: IntArray, depth: Int): ScreenNode {
        budget[0]--
        val rect = Rect().also(info::getBoundsInScreen)
        val children = if (depth >= MAX_DEPTH) emptyList() else buildList {
            for (index in 0 until info.childCount) {
                if (budget[0] <= 0) break
                val child = runCatching { info.getChild(index) }.getOrNull() ?: continue
                if (!child.isVisibleToUser) continue
                add(node(child, budget, depth + 1))
            }
        }
        return ScreenNode(
            className = info.className?.toString(),
            text = info.text?.toString(),
            desc = info.contentDescription?.toString(),
            hint = info.hintText?.toString(),
            resourceId = info.viewIdResourceName,
            left = rect.left, top = rect.top, right = rect.right, bottom = rect.bottom,
            clickable = info.isClickable,
            longClickable = info.isLongClickable,
            editable = info.isEditable,
            scrollable = info.isScrollable,
            checkable = info.isCheckable,
            checked = info.isChecked,
            selected = info.isSelected,
            focused = info.isFocused,
            enabled = info.isEnabled,
            password = info.isPassword,
            showingHint = info.isShowingHintText,
            children = children,
            handle = info,
        )
    }

    @Suppress("DEPRECATION")
    fun size(service: RiffetAccessibilityService): Pair<Int, Int> {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val bounds = service.getSystemService(WindowManager::class.java).maximumWindowMetrics.bounds
            return bounds.width() to bounds.height()
        }
        val metrics = DisplayMetrics()
        service.getSystemService(WindowManager::class.java).defaultDisplay.getRealMetrics(metrics)
        return metrics.widthPixels to metrics.heightPixels
    }
}
