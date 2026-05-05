import { NavLink } from 'react-router-dom';
import { ArchMark } from '@/components/illustrations/ArchMark';
import { cn } from '@/lib/cn';

const items: { to: string; label: string; end?: boolean }[] = [
  { to: '/app', label: 'Dashboard', end: true },
  { to: '/app/locations', label: 'Locations' },
  { to: '/app/access-points', label: 'Access points' },
  { to: '/app/devices', label: 'Devices' },
  { to: '/app/members', label: 'Members' },
  { to: '/app/billing', label: 'Billing' },
  { to: '/app/analytics', label: 'Analytics' },
];

export function AppSidebar() {
  return (
    <aside className="hidden lg:flex w-60 shrink-0 flex-col border-r border-ink/10 bg-paper-cool/60 px-4 py-6 sticky top-0 h-screen">
      <div className="flex items-center gap-2 px-2 mb-8">
        <span className="grid h-8 w-8 place-items-center rounded-md bg-ink text-paper">
          <ArchMark className="h-5 w-5" />
        </span>
        <span className="font-display italic text-lg">whatsacc</span>
      </div>

      <nav className="flex flex-col gap-0.5">
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            end={it.end}
            className={({ isActive }) =>
              cn(
                'px-3 py-2 rounded-lg text-sm transition-colors',
                isActive
                  ? 'bg-ink text-paper'
                  : 'text-ink/70 hover:bg-ink/5 hover:text-ink',
              )
            }
          >
            {it.label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto px-3 pt-6 border-t border-ink/10">
        <p className="text-[11px] uppercase tracking-[0.18em] text-ink/40 mb-2">Plan</p>
        <p className="font-display text-lg leading-none">Starter</p>
        <p className="text-xs text-ink/50 mt-1">1,243 / 2,000 msgs</p>
        <div className="mt-2 h-1 bg-ink/10 rounded-full overflow-hidden">
          <div className="h-full bg-terracotta" style={{ width: '62%' }} />
        </div>
      </div>
    </aside>
  );
}
