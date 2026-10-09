/**
 * CRX（Chrome 扩展包）解析。
 *
 * CRX 格式：
 *   - v1: "Cr24" + uint32(1) + uint32 公钥长度 + uint32 签名长度 + 公钥 + 签名 + ZIP
 *   - v2: "Cr24" + uint32(2) + uint32 头部长度 + 头部(protobuf: 公钥/签名) + ZIP
 *   - v3: "Cr24" + uint32(3) + uint32 头部长度 + 头部(CrxFile protobuf) + ZIP
 *
 * 这里只做结构解析、取出其中的 ZIP 数据，不校验签名 —— 本地安装
 * 未打包扩展本就绕过签名校验，且内容脚本注入不依赖扩展 id 与公钥绑定。
 * 直接以 ZIP（PK\x03\x04）开头的文件也接受（部分渠道以 zip 分发扩展）。
 */

const CRX_MAGIC = "Cr24"; // 0x43 0x72 0x32 0x34
const ZIP_MAGIC = "PK\x03\x04"; // 0x50 0x4B 0x03 0x04

export interface IParsedPackage {
    ok: boolean;
    error?: string;
    /** ZIP 数据（CRX 为去掉头部后的片段，ZIP 则为整个文件） */
    zip?: Buffer;
    /** crx1 / crx2 / crx3 / zip */
    format?: string;
}

export function parseExtensionPackage(buf: Buffer): IParsedPackage {
    if (!buf || buf.length < 4) {
        return { ok: false, error: "file too small to be a CRX/ZIP package" };
    }
    const magic = buf.toString("latin1", 0, 4);
    if (magic === ZIP_MAGIC) {
        return { ok: true, zip: buf, format: "zip" };
    }
    if (magic !== CRX_MAGIC) {
        return { ok: false, error: "not a CRX/ZIP file (bad magic: " + JSON.stringify(magic) + ")" };
    }
    if (buf.length < 12) {
        return { ok: false, error: "truncated CRX header" };
    }
    const version = buf.readUInt32LE(4);
    if (version === 1) {
        if (buf.length < 16) return { ok: false, error: "truncated CRX v1 header" };
        const pubKeyLen = buf.readUInt32LE(8);
        const sigLen = buf.readUInt32LE(12);
        const offset = 16 + pubKeyLen + sigLen;
        if (offset > buf.length) return { ok: false, error: "truncated CRX v1 (header overruns file)" };
        return { ok: true, zip: buf.subarray(offset), format: "crx1" };
    }
    if (version === 2 || version === 3) {
        const headerLen = buf.readUInt32LE(8);
        const offset = 12 + headerLen;
        if (offset > buf.length) return { ok: false, error: `truncated CRX v${version} (header overruns file)` };
        return { ok: true, zip: buf.subarray(offset), format: "crx" + version };
    }
    return { ok: false, error: "unsupported CRX version: " + version };
}
