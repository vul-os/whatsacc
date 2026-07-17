import { Link, NavLink } from 'react-router-dom';
import { ArchMark } from '@/components/illustrations/ArchMark';
import { cn } from '@/lib/cn';
import { APP_NAV_ITEMS } from './items';

export function AppSidebar() {
  return (
    <aside className="hidden lg:flex w-60 shrink-0 flex-col border-r border-ink/10 bg-paper-cool/60 px-4 py-6 sticky top-0 h-screen">
      <Link to="/" className="flex items-center gap-2 px-2 mb-8 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink">
        <span className="grid h-8 w-8 place-items-center rounded-md bg-ink text-paper">
          <ArchMark className="h-5 w-5" />
        </span>
        <span className="font-display italic text-lg">whatsacc</span>
      </Link>

      <nav className="flex flex-col gap-0.5">
        {APP_NAV_ITEMS.map((it) => (
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
    </aside>
  );
}
