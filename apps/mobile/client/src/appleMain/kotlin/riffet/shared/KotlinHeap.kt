package riffet.shared

import kotlin.native.runtime.GC
import kotlin.native.runtime.NativeRuntimeApi

/**
 * Bytes of live Kotlin objects after the last collection, or null before the first one: the managed
 * heap figure the Mac and iPhone report (docs/guide/performance.md §4). Pages the allocator still holds
 * are not in it; the process footprint shows those.
 */
@OptIn(NativeRuntimeApi::class, ExperimentalStdlibApi::class)
fun kotlinHeapBytes(): Long? = GC.lastGCInfo?.memoryUsageAfter?.get("heap")?.totalObjectsSizeBytes
