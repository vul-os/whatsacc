import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '@/lib/auth';

export function AppTopBar() {
  const { user } = useAuth();
  const loc = useLocation();
  const segs = loc.pathname.split('/').filter(Boolean);
  const last = segs[segs.length - 1] ?? 'app';
  const title = last === 'app' ? 'Dashboard' : last.replace(/-/g, ' ');

  return (
    <div className="sticky top-0 z-20 bg-paper/85 backdrop-blur border-b border-ink/10">
      <div className="flex items-center gap-4 px-6 lg:px-10 h-16">
        <div className="flex items-baseline gap-3">
          <span className="text-[11px] uppercase tracking-[0.18em] text-ink/45">whatsacc</span>
          <span className="text-ink/30">/</span>
          <span className="font-display text-xl capitalize">{title}</span>
        </div>

        <div className="ml-auto flex items-center gap-3">
          <Link
            to="/app/open"
            className="group/open relative flex items-center gap-2.5 pl-3 pr-5 h-10 rounded-full bg-terracotta text-paper hover:bg-terracotta-deep transition-[background,transform] hover:translate-y-[-1px] shadow-[0_8px_22px_-12px_rgba(214,98,77,0.7)]"
          >
            <span className="relative grid place-items-center h-6 w-6">
              <span className="absolute inset-0 rounded-full bg-paper/20 signal-wave" />
              <svg viewBox="0 0 24 24" className="h-4 w-4">
                <path
                  d="M6 20 V12 a6 6 0 0 1 12 0 V20 H15 V12 a3 3 0 0 0 -6 0 V20 Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinejoin="round"
                />
                <circle cx="12" cy="16" r="1.4" fill="currentColor" />
              </svg>
            </span>
            <span className="text-sm font-medium tracking-tight">Open gate</span>
          </Link>

          {user && (
            <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full border border-ink/10">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-ink text-paper text-[11px] font-medium">
                {user.name.split(' ').map((s) => s[0]).join('').slice(0, 2)}
              </span>
              <span className="text-sm text-ink/80">{user.name.split(' ')[0]}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
