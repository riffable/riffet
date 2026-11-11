package riffet.ui.composer

/** Long edge a picked image is reduced to before upload. */
const val MAX_UPLOAD_EDGE: Int = 2048

/** The server's raw attachment limit; mirrored here so the composer can reject before uploading. */
const val MAX_ATTACHMENT_BYTES: Int = 24 * 1024 * 1024

/** The bytes and metadata an upload needs, independent of how a host picked or previewed the file. */
interface UploadableAttachment {
    val name: String
    val mimeType: String
    val bytes: ByteArray
    val width: Int?
    val height: Int?
}
