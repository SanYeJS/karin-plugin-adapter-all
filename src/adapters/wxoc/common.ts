import crypto from 'node:crypto'

/** 睡眠函数
 * @param ms 毫秒
 */
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** 生成无连字符的随机UUID */
export const uuid = () => crypto.randomUUID().replaceAll('-', '')

/** 生成消息ID */
export const msgId = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`
