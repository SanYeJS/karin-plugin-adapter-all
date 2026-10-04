import type { Metadata } from 'next'
import ThemeProvider from '@/components/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import './globals.css'

export const metadata: Metadata = {
  title: '多协议适配器配置',
  description: 'Karin 多协议统一适配器 Bot 连接配置面板',
}

export default function RootLayout ({ children }: { children: React.ReactNode }) {
  return (
    <html lang='zh-CN' suppressHydrationWarning>
      <body>
        <ThemeProvider
          attribute='class'
          defaultTheme='system'
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  )
}