import axios from 'node-karin/axios'
import type { AxiosError, AxiosRequestConfig, AxiosResponse } from 'node-karin/axios'

/** 统一请求 超时原样抛出 其余错误统一转换为带前缀的 Error 并携带 status */
export const http = async (config: AxiosRequestConfig, label: string): Promise<AxiosResponse<unknown>> =>
  axios(config).catch((error: AxiosError) => {
    /** 超时原样抛出 由长轮询识别为正常控制流 */
    if (['ECONNABORTED', 'ETIMEDOUT'].includes(error.code || '')) throw error

    const status = error.response?.status
    const data = error.response?.data
    const detail = typeof data === 'string' && data ? data : error?.message || '未知'
    throw Object.assign(new Error(`${label}: ${status ? `HTTP ${status}: ${detail}` : detail}`), { status })
  })
