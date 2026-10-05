import crypto from 'node:crypto'

/** 根据密钥长度获取算法 */
const algo = (key: Buffer): string => {
  if (key.length === 16) return 'aes-128-ecb'
  if (key.length === 24) return 'aes-192-ecb'
  if (key.length === 32) return 'aes-256-ecb'
  throw new Error(`不支持的 AES 密钥长度: ${key.length}`)
}

/** PKCS7 填充 */
const pad = (data: Buffer, size = 16): Buffer => {
  const len = size - (data.length % size)
  return Buffer.concat([data, Buffer.alloc(len, len)])
}

/** PKCS7 去填充 */
const unpad = (data: Buffer, size = 16): Buffer => {
  const len = data[data.length - 1]
  if (!len || len < 1 || len > size) return data
  return data.subarray(0, data.length - len)
}

/** AES-ECB 加密 */
export const encrypt = (data: Buffer, key: Buffer): Buffer => {
  const cipher = crypto.createCipheriv(algo(key), key, null)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(pad(data)), cipher.final()])
}

/** AES-ECB 解密 */
export const decrypt = (data: Buffer, key: Buffer): Buffer => {
  const decipher = crypto.createDecipheriv(algo(key), key, null)
  decipher.setAutoPadding(false)
  return unpad(Buffer.concat([decipher.update(data), decipher.final()]))
}
