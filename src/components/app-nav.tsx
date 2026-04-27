'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ThemeToggle } from '@/components/theme-toggle'

type NavItem = { href: string; label: string }

const NAV_ITEMS: NavItem[] = [
  { href: '/pnl',              label: 'P&L'       },
  { href: '/chart',            label: 'График'    },
  { href: '/expenses',         label: 'Расходы'   },
  { href: '/expenses/import',  label: 'Импорт'    },
  { href: '/settings',         label: 'Настройки' },
]

/** Returns true when the current path matches the nav item (prefix match). */
function isActive(itemHref: string, pathname: string): boolean {
  return pathname === itemHref || pathname.startsWith(itemHref + '/')
}

export function AppNav() {
  const pathname = usePathname()

  return (
    <nav
      className="sticky top-0 z-50 flex items-center gap-1 px-4"
      style={{
        height: 'var(--nav-h)',
        background: 'var(--bg-card)',
        borderBottom: '1px solid var(--border-primary)',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      {/* Logo */}
      <Link
        href="/pnl"
        className="mr-3 text-base font-bold shrink-0 tracking-tight"
        style={{ color: 'var(--text-primary)' }}
      >
        P&amp;L
      </Link>

      {/* Divider */}
      <span
        className="mr-3 shrink-0 h-4 w-px"
        style={{ background: 'var(--border-secondary)' }}
        aria-hidden
      />

      {/* Nav links */}
      <div className="flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto">
        {NAV_ITEMS.map((item) => {
          const active = isActive(item.href, pathname)
          return (
            <Link
              key={item.href}
              href={item.href}
              className="shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap"
              style={
                active
                  ? {
                      background: 'var(--accent-soft)',
                      color: 'var(--accent-primary)',
                    }
                  : {
                      color: 'var(--text-secondary)',
                    }
              }
              // Inline hover via CSS — we add a data-attr trick with a class
              data-nav-link=""
            >
              {item.label}
            </Link>
          )
        })}
      </div>

      {/* Right slot */}
      <div className="ml-auto pl-2 shrink-0">
        <ThemeToggle />
      </div>
    </nav>
  )
}
