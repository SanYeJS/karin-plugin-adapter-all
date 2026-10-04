import type { Elements } from 'node-karin'
import type { MsgReplaceRule } from '../adapters/base'

/**
 * 对文本依次应用全部替换规则。
 * match 编译为正则模式 (全局匹配), to 为替换内容 (支持 $1 等捕获组引用);
 * 非法正则静默跳过, 不影响后续规则。
 */
export const applyTextReplace = (text: string, rules?: MsgReplaceRule[]): string => {
  if (!rules || rules.length === 0) return text
  let out = text
  for (const rule of rules) {
    const pattern = String(rule?.match || '').trim()
    if (!pattern) continue
    try {
      out = out.replace(new RegExp(pattern, 'g'), String(rule.to ?? ''))
    } catch {
      // 非法正则跳过
    }
  }
  return out
}

/**
 * 对 Karin 消息 elements 应用替换 (仅 text 段)。
 * 命令类内容通常位于首段文本, 对所有 text 段替换以兼容多段拼接的消息。
 * enable 为 false 时整体跳过 (默认开启)。
 */
export const applyMsgReplace = (elements: Elements[], rules?: MsgReplaceRule[], enable?: boolean): Elements[] => {
  if (enable === false) return elements
  if (!rules || rules.length === 0) return elements
  return elements.map((e) => {
    const el = e as any
    if (el?.type !== 'text') return e
    return { ...el, text: applyTextReplace(String(el.text ?? ''), rules) }
  })
}