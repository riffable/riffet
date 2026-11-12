package riffet.shared

import riffet.contracts.GitCommit
import riffet.contracts.GitLineChange

/** A lane of the history graph: its column and the colour it keeps from the commit that opened it. */
data class GitGraphLane(val column: Int, val color: Int)

/**
 * One row of the history graph (see [layoutGitGraph]). A row can be drawn on its own: lanes in
 * [from] come down into the commit from the top edge, lanes in [to] leave it for the bottom edge,
 * and [through] runs from top to bottom past it.
 */
data class GitGraphRow(
    /** The lane the commit sits in. */
    val column: Int,
    val color: Int,
    /** Lanes above the commit that end at it: its own, and those of branches that started from it. */
    val from: List<GitGraphLane>,
    /** Lanes the commit's lines leave to, one per parent. */
    val to: List<GitGraphLane>,
    /** Lanes that pass the commit by. */
    val through: List<GitGraphLane>,
    /** How many lanes wide the row is. */
    val width: Int,
)

/**
 * Lays commits (newest first, each naming its parents) out as the lanes of a graph. A lane is a
 * column reserved for the commit a line is heading to. Same layout as the web panel's `gitGraph.ts`.
 */
fun layoutGitGraph(commits: List<GitCommit>): List<GitGraphRow> {
    data class Lane(val hash: String, val color: Int)
    val lanes = mutableListOf<Lane?>()
    var colors = 0
    fun free(): Int = lanes.indexOf(null).let { if (it == -1) lanes.size else it }
    fun put(slot: Int, lane: Lane) { if (slot == lanes.size) lanes.add(lane) else lanes[slot] = lane }
    return commits.map { commit ->
        val arriving = lanes.indices.filter { lanes[it]?.hash == commit.hash }
        val column = arriving.firstOrNull() ?: free()
        val color = lanes.getOrNull(column)?.color ?: colors++
        val from = arriving.map { GitGraphLane(it, lanes[it]!!.color) }
        val through = lanes.indices.mapNotNull { index -> lanes[index]?.takeIf { it.hash != commit.hash }?.let { GitGraphLane(index, it.color) } }
        val before = lanes.size
        for (index in arriving) lanes[index] = null
        val to = commit.parents.mapIndexed { order, parent ->
            val known = lanes.indexOfFirst { it?.hash == parent }
            if (known != -1) return@mapIndexed GitGraphLane(known, lanes[known]!!.color)
            // The first parent carries the commit's own line on; any other is a branch merged in here.
            val slot = if (order == 0) column else free()
            val lane = Lane(parent, if (order == 0) color else colors++)
            put(slot, lane)
            GitGraphLane(slot, lane.color)
        }
        while (lanes.isNotEmpty() && lanes.last() == null) lanes.removeAt(lanes.lastIndex)
        GitGraphRow(column, color, from, to, through, maxOf(before, lanes.size, column + 1))
    }
}

/** One run of changed lines in a diff's patch. [patchLine] is the index, in the patch's lines, of the run's first `-` or `+` line. */
data class GitPatchChunk(val change: GitLineChange, val patchLine: Int)

/**
 * The runs of changed lines in a unified [patch], each as the line ranges `POST git/lines` takes.
 * Context lines split runs, so every chunk is one contiguous change, as in a side-by-side diff.
 */
fun gitPatchChunks(patch: String): List<GitPatchChunk> {
    val chunks = mutableListOf<GitPatchChunk>()
    val header = Regex("""^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@""")
    var before = -1
    var after = -1
    var start: Triple<Int, Int, Int>? = null
    fun close() {
        val open = start ?: return
        chunks += GitPatchChunk(GitLineChange(listOf(open.first.toLong(), before.toLong()), listOf(open.second.toLong(), after.toLong())), open.third)
        start = null
    }
    patch.split('\n').forEachIndexed { index, line ->
        val match = header.find(line)
        if (match != null) {
            close()
            val (b, bCount, a, aCount) = match.destructured
            // An empty side names the line before the gap, so its zero-based start is the number itself.
            before = if (bCount == "0") b.toInt() else b.toInt() - 1
            after = if (aCount == "0") a.toInt() else a.toInt() - 1
            return@forEachIndexed
        }
        if (before < 0) return@forEachIndexed
        when {
            line.startsWith("-") -> { if (start == null) start = Triple(before, after, index); before += 1 }
            line.startsWith("+") -> { if (start == null) start = Triple(before, after, index); after += 1 }
            line.startsWith("\\") -> Unit
            else -> { close(); before += 1; after += 1 }
        }
    }
    close()
    return chunks
}
