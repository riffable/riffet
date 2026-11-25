import Foundation
import RiffetKit
import Security

/// This iPhone's TLS identity (docs/TRANSPORT-SECURITY.md §2): a P-256 key in the Secure Enclave, never exportable,
/// and a self-signed certificate over it, kept in the keychain so the two form a `SecIdentity`. It answers a server's
/// client-certificate request; the server binds the device token to it. Where there is no Secure Enclave (the
/// simulator) the key is an ordinary keychain key.
final class DeviceIdentity: NSObject, DeviceCredentialProvider, @unchecked Sendable {
    static let shared = DeviceIdentity()

    private static let tag = Data("io.github.riffable.iphone.device-tls".utf8)
    private static let label = "Riffet device certificate"
    private let lock = NSLock()
    private var cached: URLCredential?

    /// The credential for a client-certificate challenge, made on first use.
    func credential() -> URLCredential? {
        lock.lock(); defer { lock.unlock() }
        if let cached { return cached }
        guard let identity = Self.identity() ?? Self.make() else { return nil }
        let made = URLCredential(identity: identity, certificates: nil, persistence: .forSession)
        cached = made
        return made
    }

    private static func identity() -> SecIdentity? {
        let query: [String: Any] = [kSecClass as String: kSecClassIdentity, kSecAttrLabel as String: label, kSecReturnRef as String: true]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let item else { return nil }
        return (item as! SecIdentity)
    }

    private static func make() -> SecIdentity? {
        guard let key = privateKey() ?? newKey(), let publicKey = SecKeyCopyPublicKey(key),
              let point = SecKeyCopyExternalRepresentation(publicKey, nil) as Data?,
              let der = certificate(point: point, key: key),
              let certificate = SecCertificateCreateWithData(nil, der as CFData) else { return nil }
        let add: [String: Any] = [kSecClass as String: kSecClassCertificate, kSecValueRef as String: certificate, kSecAttrLabel as String: label]
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess || status == errSecDuplicateItem else { return nil }
        return identity()
    }

    private static func privateKey() -> SecKey? {
        let query: [String: Any] = [kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: tag, kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecReturnRef as String: true]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let item else { return nil }
        return (item as! SecKey)
    }

    private static func newKey() -> SecKey? {
        func attributes(enclave: Bool) -> [String: Any] {
            var access: SecAccessControl?
            if enclave { access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, nil) }
            var privateAttributes: [String: Any] = [kSecAttrIsPermanent as String: true, kSecAttrApplicationTag as String: tag]
            if let access { privateAttributes[kSecAttrAccessControl as String] = access } else { privateAttributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly }
            var result: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeySizeInBits as String: 256, kSecPrivateKeyAttrs as String: privateAttributes]
            if enclave { result[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave }
            return result
        }
        return SecKeyCreateRandomKey(attributes(enclave: true) as CFDictionary, nil)
            ?? SecKeyCreateRandomKey(attributes(enclave: false) as CFDictionary, nil)
    }

    // MARK: - A self-signed X.509 certificate, DER-encoded by hand (the server's links/identity.ts does the same).

    private static func certificate(point: Data, key: SecKey) -> Data? {
        let ecdsaSHA256 = sequence([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02])
        let spki = sequence(sequence([0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01] + [0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]) + tlv(0x03, [0x00] + [UInt8](point)))
        let name = sequence(tlv(0x31, sequence([0x06, 0x03, 0x55, 0x04, 0x03] + tlv(0x0c, [UInt8]("Riffet device".utf8)))))
        var serial = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, serial.count, &serial)
        serial[0] = (serial[0] & 0x3f) | 0x40
        let now = Date()
        let validity = sequence(utcTime(now.addingTimeInterval(-86_400)) + utcTime(Date(timeIntervalSince1970: 2_524_607_999)))
        let tbs = sequence(tlv(0xa0, tlv(0x02, [0x02])) + tlv(0x02, serial) + ecdsaSHA256 + name + validity + name + spki)
        guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, Data(tbs) as CFData, nil) as Data? else { return nil }
        return Data(sequence(tbs + ecdsaSHA256 + tlv(0x03, [0x00] + [UInt8](signature))))
    }

    private static func utcTime(_ date: Date) -> [UInt8] {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyMMddHHmmss'Z'"
        return tlv(0x17, [UInt8](formatter.string(from: date).utf8))
    }

    private static func sequence(_ content: [UInt8]) -> [UInt8] { tlv(0x30, content) }

    private static func tlv(_ tag: UInt8, _ content: [UInt8]) -> [UInt8] {
        let count = content.count
        let length: [UInt8] = count < 0x80 ? [UInt8(count)]
            : count < 0x100 ? [0x81, UInt8(count)]
            : [0x82, UInt8(count >> 8), UInt8(count & 0xff)]
        return [tag] + length + content
    }
}
