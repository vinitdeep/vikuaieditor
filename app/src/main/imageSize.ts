/** Minimal header parsers so the capture code can filter by pixel size without native deps. */
export interface ImageInfo {
  width: number
  height: number
  ext: 'png' | 'jpg' | 'webp' | 'gif'
}

export function imageInfo(buf: Buffer): ImageInfo | null {
  if (buf.length < 24) return null
  // PNG
  if (buf.readUInt32BE(0) === 0x89504e47) {
    return { ext: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  // GIF
  if (buf.toString('ascii', 0, 3) === 'GIF') {
    return { ext: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  }
  // WebP
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16)
    if (chunk === 'VP8X' && buf.length >= 30) {
      return { ext: 'webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
      const b = buf.readUInt32LE(21)
      return { ext: 'webp', width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) }
    }
    if (chunk === 'VP8 ' && buf.length >= 30) {
      return { ext: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
    }
    return null
  }
  // JPEG: walk segments until a SOFn marker
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++
        continue
      }
      const marker = buf[i + 1]
      const len = buf.readUInt16BE(i + 2)
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof) return { ext: 'jpg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
      i += 2 + len
    }
  }
  return null
}
