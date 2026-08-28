// opensubtitles.com movie hash: size + uint64 sums of the first/last 64 KB.
// Only reads ~128 KB per video, so it's fast even over WiFi/SMB.

import fs from "node:fs";

export async function openSubtitlesHash(filePath) {
  const fh = await fs.promises.open(filePath, "r");
  try {
    const size = (await fh.stat()).size;
    const READ = 65536;
    let acc = BigInt(size) & 0xffffffffffffffffn;
    const readChunk = async (off) => {
      const len = Math.min(READ, Math.max(0, size - off));
      if (len <= 0) return;
      const buf = Buffer.alloc(len);
      const r = await fh.read(buf, 0, len, off);
      for (let i = 0; i + 8 <= r.bytesRead; i += 8) {
        acc = (acc + buf.readBigUInt64LE(i)) & 0xffffffffffffffffn;
      }
    };
    await readChunk(0);
    await readChunk(Math.max(0, size - READ));
    return acc.toString(16).padStart(16, "0");
  } finally {
    await fh.close();
  }
}
