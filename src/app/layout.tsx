import type { Metadata } from 'next'
import './globals.css'
import { ThemeProvider } from '@/lib/theme'
import { AppNav } from '@/components/app-nav'

export const metadata: Metadata = {
  title: 'P&L',
  description: 'P&L management application',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <head>
        {/* Prevent flash of wrong theme */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');var d=t||(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');if(d==='dark')document.documentElement.classList.add('dark')}catch(e){}})()`,
          }}
        />
      </head>
      <body>
        <ThemeProvider>
          <AppNav />
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}
