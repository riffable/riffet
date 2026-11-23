package riffet.shared

import riffet.contracts.TerminalWireFrame

/** Decoded protocol 4 binary frame sent by the server. */
internal sealed interface TerminalBinaryServerFrame {
    data class Output(val sequence: Long, val streamId: String, val data: String) : TerminalBinaryServerFrame
    data class Snapshot(val sequence: Long, val cols: Int, val rows: Int, val streamId: String, val data: String) : TerminalBinaryServerFrame
    data class Ping(val timestamp: Long) : TerminalBinaryServerFrame
    data class Pong(val timestamp: Long) : TerminalBinaryServerFrame
}

internal fun decodeServerBinaryFrame(raw: ByteArray): TerminalBinaryServerFrame? {
    if (raw.isEmpty()) return null
    return when (raw[0]) {
        TerminalWireFrame.OUTPUT -> {
            if (raw.size < 6) return null
            val seq = readUInt32BE(raw, 1)
            val idLen = raw[5].toInt() and 0xFF
            if (raw.size < 6 + idLen) return null
            val streamId = raw.decodeToString(6, 6 + idLen)
            val data = raw.decodeToString(6 + idLen, raw.size)
            TerminalBinaryServerFrame.Output(seq, streamId, data)
        }
        TerminalWireFrame.SNAPSHOT_RAW, TerminalWireFrame.SNAPSHOT_DEFLATE -> {
            if (raw.size < 10) return null
            val seq = readUInt32BE(raw, 1)
            val cols = readUInt16BE(raw, 5)
            val rows = readUInt16BE(raw, 7)
            val idLen = raw[9].toInt() and 0xFF
            if (raw.size < 10 + idLen) return null
            val streamId = raw.decodeToString(10, 10 + idLen)
            val data = if (raw[0] == TerminalWireFrame.SNAPSHOT_DEFLATE) {
                val payload = raw.copyOfRange(10 + idLen, raw.size)
                val inflated = inflateRaw(payload) ?: return null
                inflated.decodeToString()
            } else {
                raw.decodeToString(10 + idLen, raw.size)
            }
            TerminalBinaryServerFrame.Snapshot(seq, cols, rows, streamId, data)
        }
        TerminalWireFrame.PING -> {
            if (raw.size < 9) return null
            TerminalBinaryServerFrame.Ping(readInt64BE(raw, 1))
        }
        TerminalWireFrame.PONG -> {
            if (raw.size < 9) return null
            TerminalBinaryServerFrame.Pong(readInt64BE(raw, 1))
        }
        else -> null
    }
}

/** Encodes a protocol 4 binary `input` frame: `[0x04][epoch:u32be][clientIdLen:u8][clientId:utf8][payload:utf8]`. */
internal fun encodeInputBinaryFrame(clientId: String, epoch: Long, data: String): ByteArray {
    val idBytes = clientId.encodeToByteArray()
    val idLen = minOf(idBytes.size, 255)
    val payload = data.encodeToByteArray()
    val frame = ByteArray(6 + idLen + payload.size)
    frame[0] = TerminalWireFrame.INPUT
    writeUInt32BE(frame, 1, epoch)
    frame[5] = idLen.toByte()
    idBytes.copyInto(frame, 6, 0, idLen)
    payload.copyInto(frame, 6 + idLen)
    return frame
}

/** Encodes a protocol 4 binary `pong` frame echoing the server's ping timestamp. */
internal fun encodePongBinaryFrame(timestamp: Long): ByteArray = encodeHeartbeatBinaryFrame(TerminalWireFrame.PONG, timestamp)

/** Encodes a protocol 4 binary `ping` frame. */
internal fun encodePingBinaryFrame(timestamp: Long): ByteArray = encodeHeartbeatBinaryFrame(TerminalWireFrame.PING, timestamp)

private fun encodeHeartbeatBinaryFrame(type: Byte, timestamp: Long): ByteArray {
    val frame = ByteArray(9)
    frame[0] = type
    writeInt64BE(frame, 1, timestamp)
    return frame
}

private fun readUInt16BE(buf: ByteArray, offset: Int): Int =
    ((buf[offset].toInt() and 0xFF) shl 8) or (buf[offset + 1].toInt() and 0xFF)

private fun readUInt32BE(buf: ByteArray, offset: Int): Long =
    ((buf[offset].toLong() and 0xFF) shl 24) or
        ((buf[offset + 1].toLong() and 0xFF) shl 16) or
        ((buf[offset + 2].toLong() and 0xFF) shl 8) or
        (buf[offset + 3].toLong() and 0xFF)

private fun readInt64BE(buf: ByteArray, offset: Int): Long {
    var result = 0L
    for (i in 0 until 8) result = (result shl 8) or (buf[offset + i].toLong() and 0xFF)
    return result
}

private fun writeUInt32BE(buf: ByteArray, offset: Int, value: Long) {
    buf[offset] = ((value ushr 24) and 0xFF).toByte()
    buf[offset + 1] = ((value ushr 16) and 0xFF).toByte()
    buf[offset + 2] = ((value ushr 8) and 0xFF).toByte()
    buf[offset + 3] = (value and 0xFF).toByte()
}

private fun writeInt64BE(buf: ByteArray, offset: Int, value: Long) {
    for (i in 0 until 8) buf[offset + i] = ((value ushr (56 - i * 8)) and 0xFF).toByte()
}
