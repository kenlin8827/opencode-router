/**
 * Minimal ClientHello SNI extractor.
 *
 * Bun's `node:tls` does not implement `SNICallback` (verified on 1.3.14), so
 * the MITM path cannot ask the TLS stack for the servername — we peek the raw
 * ClientHello off the CONNECT tunnel before handing the socket to the
 * per-host TLS server and read the `server_name` extension ourselves.
 *
 * Returns null when the buffer does not (yet) contain a complete ClientHello
 * record or carries no SNI (e.g. IP-only clients); the caller then falls back
 * to a blind tunnel. Never throws.
 */
export function parseClientHelloSNI(buf: Buffer): string | null {
  try {
    if (buf.length < 5 || buf[0] !== 0x16) return null; // TLS handshake record
    const recLen = buf.readUInt16BE(3);
    if (buf.length < 5 + recLen) return null; // incomplete record — need more bytes
    const hs = buf.subarray(5, 5 + recLen);
    if (hs[0] !== 0x01) return null; // ClientHello
    let p = 4 + 2 + 32; // handshake header(4) + client version(2) + random(32)
    const sidLen = hs[p];
    p += 1 + sidLen;
    if (p + 2 > hs.length) return null;
    const csLen = hs.readUInt16BE(p);
    p += 2 + csLen;
    if (p + 1 > hs.length) return null;
    const compLen = hs[p];
    p += 1 + compLen;
    if (p + 2 > hs.length) return null; // no extensions
    const extLen = hs.readUInt16BE(p);
    p += 2;
    const extEnd = Math.min(p + extLen, hs.length);
    while (p + 4 <= extEnd) {
      const type = hs.readUInt16BE(p);
      const len = hs.readUInt16BE(p + 2);
      p += 4;
      if (type === 0x0000) {
        // server_name extension: [listLen(2)][nameType(1)=0][nameLen(2)][name]
        let q = p + 2;
        const nameType = hs[q];
        q += 1;
        const nameLen = hs.readUInt16BE(q);
        q += 2;
        if (nameType === 0 && q + nameLen <= hs.length) {
          return hs.subarray(q, q + nameLen).toString('ascii');
        }
        return null;
      }
      p += len;
    }
    return null;
  } catch {
    return null;
  }
}