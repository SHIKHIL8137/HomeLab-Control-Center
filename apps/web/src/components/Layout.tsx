import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  Activity,
  BellRing,
  Box,
  FolderKanban,
  History,
  KeyRound,
  LayoutDashboard,
  Menu,
  Moon,
  Rocket,
  ScrollText,
  Settings,
  Sun,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useLiveUpdates, useOverview } from '../hooks';
import { applyTheme, getTheme, type Theme } from '../lib/theme';
import { cx } from './ui';

const NAV: { to: string; label: string; icon: LucideIcon; end?: boolean }[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/projects', label: 'Projects', icon: FolderKanban },
  { to: '/containers', label: 'Containers', icon: Box },
  { to: '/deployments', label: 'Deployments', icon: Rocket },
  { to: '/logs', label: 'Logs', icon: ScrollText },
  { to: '/monitoring', label: 'Monitoring', icon: Activity },
  { to: '/alerts', label: 'Alerts & Incidents', icon: BellRing },
  { to: '/environment', label: 'Environment', icon: KeyRound },
  { to: '/audit', label: 'Audit History', icon: History },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function Layout() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(getTheme);
  const live = useLiveUpdates();
  const { data } = useOverview();

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setTheme(next);
  };

  const nav = (
    <nav aria-label="Main" className="flex flex-col gap-0.5 p-3">
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={() => setOpen(false)}
          className={({ isActive }) =>
            cx(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium',
              isActive ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-raised hover:text-fg',
            )
          }
        >
          <Icon className="h-4 w-4" aria-hidden />
          {label}
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[15rem_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-surface focus:p-2"
      >
        Skip to content
      </a>

      <aside className="hidden border-r border-line bg-surface lg:block">
        <div className="px-5 py-4 text-sm font-semibold">HomeLab Control Center</div>
        {nav}
      </aside>

      {open && (
        <div
          className="fixed inset-0 z-40 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
        >
          <button
            className="absolute inset-0 bg-black/50"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
          />
          <div className="relative h-full w-64 bg-surface shadow-xl">
            <div className="flex items-center justify-between px-5 py-4 text-sm font-semibold">
              HomeLab Control Center
              <button aria-label="Close menu" onClick={() => setOpen(false)}>
                <X className="h-5 w-5" />
              </button>
            </div>
            {nav}
          </div>
        </div>
      )}

      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-surface/95 px-4 py-2.5 backdrop-blur">
          <button className="lg:hidden" aria-label="Open menu" onClick={() => setOpen(true)}>
            <Menu className="h-5 w-5" />
          </button>
          <span className="text-sm font-semibold lg:hidden">HomeLab</span>
          <span className="ml-auto flex items-center gap-3 text-xs text-muted">
            <span title="Server-sent events keep this page current between polls">
              {live ? 'Live updates on' : 'Live updates off (polling)'}
            </span>
            <button
              onClick={toggleTheme}
              className="rounded-lg border border-line p-1.5 hover:bg-raised"
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </span>
        </header>

        {data?.mode === 'mock' && (
          <div
            role="status"
            className="border-b border-warn/40 bg-warn/10 px-4 py-1.5 text-center text-xs font-medium text-warn"
          >
            DEMO MODE — every figure is simulated. This page is not connected to your server.
          </div>
        )}

        <main id="main" className="mx-auto max-w-7xl p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
