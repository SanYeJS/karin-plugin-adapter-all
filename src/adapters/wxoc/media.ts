import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { http } from './http'
import type { Detected, FormatInfo, ResolveOptions, Resolved } from './types'

/** 常见媒体格式 */
const FORMATS: Record<string, FormatInfo> = {
  jpg: { mime: 'image/jpeg', ext: '.jpg', kind: 'image' },
  png: { mime: 'image/png', ext: '.png', kind: 'image' },
  gif: { mime: 'image/gif', ext: '.gif', kind: 'image' },
  webp: { mime: 'image/webp', ext: '.webp', kind: 'image' },
  bmp: { mime: 'image/bmp', ext: '.bmp', kind: 'image' },
  mp4: { mime: 'video/mp4', ext: '.mp4', kind: 'video' },
  avi: { mime: 'video/x-msvideo', ext: '.avi', kind: 'video' },
  mkv: { mime: 'video/x-matroska', ext: '.mkv', kind: 'video' },
  webm: { mime: 'video/webm', ext: '.webm', kind: 'video' },
  wav: { mime: 'audio/wav', ext: '.wav', kind: 'audio' },
  mp3: { mime: 'audio/mpeg', ext: '.mp3', kind: 'audio' },
  ogg: { mime: 'audio/ogg', ext: '.ogg', kind: 'audio' },
  flac: { mime: 'audio/flac', ext: '.flac', kind: 'audio' },
  amr: { mime: 'audio/amr', ext: '.amr', kind: 'audio' },
  silk: { mime: 'audio/silk', ext: '.silk', kind: 'audio' },
  aac: { mime: 'audio/aac', ext: '.aac', kind: 'audio' },
  m4a: { mime: 'audio/mp4', ext: '.m4a', kind: 'audio' },
}

/** 别名后缀映射 */
const EXT_ALIAS = new Map(Object.entries(FORMATS).map(([format, info]) => [info.ext, format]))
EXT_ALIAS.set('.jpeg', 'jpg').set('.jpe', 'jpg').set('.m4v', 'mp4').set('.mov', 'mp4')

const magic = (buffer: Buffer, hex: string, offset = 0) =>
  buffer.length >= offset + hex.length / 2 && buffer.subarray(offset, offset + hex.length / 2).equals(Buffer.from(hex, 'hex'))

const ascii = (buffer: Buffer, text: string, offset = 0) =>
  buffer.length >= offset + text.length && buffer.subarray(offset, offset + text.length).equals(Buffer.from(text))

/** 通过文件头识别格式 */
const detectByContent = (buffer: Buffer): string => {
  if (magic(buffer, 'ffd8ff')) return 'jpg'
  if (magic(buffer, '89504e470d0a1a0a')) return 'png'
  if (ascii(buffer, 'GIF87a') || ascii(buffer, 'GIF89a')) return 'gif'
  if (ascii(buffer, 'RIFF') && ascii(buffer, 'WEBP', 8)) return 'webp'
  if (ascii(buffer, 'BM')) return 'bmp'
  if (ascii(buffer, 'RIFF') && ascii(buffer, 'WAVE', 8)) return 'wav'
  if (ascii(buffer, 'RIFF') && ascii(buffer, 'AVI ', 8)) return 'avi'
  if (ascii(buffer, 'ftyp', 4)) return 'mp4'
  if (magic(buffer, '1a45dfa3')) return 'mkv'
  if (ascii(buffer, 'ID3') || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) return 'mp3'
  if (ascii(buffer, 'OggS')) return 'ogg'
  if (ascii(buffer, 'fLaC')) return 'flac'
  if (ascii(buffer, '#!AMR')) return 'amr'
  if (ascii(buffer, '#!SILK_V3')) return 'silk'
  if (buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0) return 'aac'
  return ''
}

const formatByName = (fileName: string) => EXT_ALIAS.get(path.extname(fileName || '').toLowerCase()) || ''

const formatByMime = (mime: string) => {
  const normalized = String(mime || '').split(';', 1)[0].trim().toLowerCase()
  return Object.entries(FORMATS).find(([, info]) => info.mime === normalized)?.[0] || ''
}

const safeName = (name: string, fallback = 'file') =>
  path.basename(String(name || '').replaceAll('\\', '/')).trim() || fallback

/** 识别媒体格式 优先文件头 其次声明 mime/文件名 */
export const detectMedia = (buffer: Buffer, fileName = '', mimeType = ''): Detected => {
  const format = detectByContent(buffer) || formatByMime(mimeType) || formatByName(fileName)
  const info = FORMATS[format]
  return {
    format,
    mime: info?.mime || mimeType.split(';', 1)[0].trim() || 'application/octet-stream',
    ext: info?.ext || path.extname(fileName || '').toLowerCase(),
    kind: info?.kind || 'file',
  }
}

/** 日志脱敏 移除 base64/密钥等敏感内容 */
export const sanitizeLog = (value: string): string =>
  String(value)
    .replace(/data:[^,\s]+,[A-Za-z0-9+/_=-]+/gi, match => `data:...,length=${match.length}`)
    .replace(/base64:\/\/[A-Za-z0-9+/_=-]+/gi, match => `base64://...,length=${match.length - 9}`)
    .replace(/\b(encrypt_query_param|upload_param|aes_key|authorization|token)=([^&\s"',}]+)/gi, '$1=...')

const decodeBase64 = (payload: string, maxBytes: number): Buffer => {
  const compact = payload.replace(/\s+/g, '')
  const padded = compact + '='.repeat((4 - (compact.replace(/=+$/, '').length % 4)) % 4)
  const buffer = Buffer.from(padded, 'base64')
  if (buffer.length > maxBytes) throw new Error(`媒体大小超出限制 (${maxBytes})`)
  return buffer
}

const nameFromUrl = (url: URL): string => {
  const dispositionName = url.pathname.split('/').pop()
  try {
    return safeName(decodeURIComponent(dispositionName || ''))
  } catch {
    return safeName(dispositionName || '')
  }
}

/**
 * 解析媒体引用
 * 支持 Buffer、base64://、data:、http(s)://、file://、本地路径、裸 base64
 */
export const resolveMedia = async (
  mediaRef: Buffer | string,
  options: ResolveOptions = {}
): Promise<Resolved> => {
  const { timeoutMs = 15000, maxBytes = 100 * 1024 * 1024, fileName: suppliedName = '' } = options
  let fileName = safeName(suppliedName)
  let mimeType = ''
  let buffer: Buffer

  if (Buffer.isBuffer(mediaRef)) {
    buffer = mediaRef
  } else if (/^base64:\/\//i.test(mediaRef)) {
    buffer = decodeBase64(mediaRef.slice(9), maxBytes)
  } else if (/^data:/i.test(mediaRef)) {
    const comma = mediaRef.indexOf(',')
    if (comma < 0) throw new Error('无效的 data URI')
    const header = mediaRef.slice(5, comma).split(';')
    if (!header.slice(1).some(part => part.toLowerCase() === 'base64')) throw new Error('仅支持 base64 data URI')
    mimeType = header[0] || ''
    buffer = decodeBase64(mediaRef.slice(comma + 1), maxBytes)
  } else {
    let url: URL | null = null
    try {
      url = new URL(mediaRef)
    } catch {
      url = null
    }

    if (url && /^https?:$/.test(url.protocol)) {
      const response = await http({
        url: url.href,
        method: 'get',
        timeout: Math.max(timeoutMs, 1),
        responseType: 'arraybuffer',
      }, '下载媒体失败')

      buffer = Buffer.from(response.data as ArrayBuffer)
      if (buffer.length > maxBytes) throw new Error(`媒体大小超出限制 (${maxBytes})`)
      mimeType = String(response.headers?.['content-type'] || '')
      if (!suppliedName) fileName = nameFromUrl(url)
    } else {
      const filePath = url && url.protocol === 'file:' ? fileURLToPath(url) : mediaRef
      try {
        const stat = await fs.stat(filePath)
        if (!stat.isFile()) throw new Error('路径不是文件')
        if (stat.size > maxBytes) throw new Error(`媒体大小超出限制 (${maxBytes})`)
        buffer = await fs.readFile(filePath)
        if (!suppliedName) fileName = safeName(filePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        buffer = decodeBase64(mediaRef, maxBytes)
      }
    }
  }

  const detected = detectMedia(buffer, fileName, mimeType)
  if (detected.ext) {
    const current = formatByName(fileName)
    if (!current || current !== detected.format) {
      fileName = `${path.parse(fileName).name || 'file'}${detected.ext}`
    }
  }

  return { buffer, fileName, ...detected }
}
