import { NavLink, Outlet } from 'react-router-dom';
import { TopNav } from '@/components/nav/TopNav';
import { Footer } from '@/components/landing/Footer';
import { cn } from '@/lib/cn';

const groups: { head: string; items: { to: string; label: string }[] }[] = [
  {
    head: 'Start here',
    items: [
      { to: '/docs', label: 'Getting started' },
      { to: '/docs/linking-whatsapp', label: 'Linking your WhatsApp number' },
    ],
  },
  {
    head: 'Concepts',
    items: [
      { to: '/docs/locations', label: 'Creating a Location' },
      { to: '/docs/pairing-device', label: 'Pairing a Device' },
      { to: '/docs/permissions-members', label: 'Permissions & Members' },
      { to: '/docs/geofence-safety', label: 'Geofence safety' },
    ],
  },
  {
    head: 'Reference',
    items: [{ to: '/docs/api-reference', label: 'API reference' }],
  },
];

export default function DocsLayout() {
  return (
    <div className="bg-paper">
      <TopNav />

      <div className="mx-auto max-w-[1280px] px-5 sm:px-6 lg:px-10 py-8 sm:py-12">
        {/* Mobile chip nav */}
        <nav className="lg:hidden -mx-5 sm:-mx-6 mb-6 px-5 sm:px-6 overflow-x-auto">
          <ul className="flex items-center gap-2 whitespace-nowrap pb-1">
            {groups.flatMap((g) =>
              g.items.map((it) => (
                <li key={it.to}>
                  <NavLink
                    to={it.to}
                    end={it.to === '/docs'}
                    className={({ isActive }) =>
                      cn(
                        'inline-block px-3 py-1.5 rounded-full text-xs border transition-colors',
                        isActive
                          ? 'bg-ink text-paper border-ink'
                          : 'bg-paper-cool text-ink/70 border-ink/10 hover:border-ink/30',
                      )
                    }
                  >
                    {it.label}
                  </NavLink>
                </li>
              )),
            )}
          </ul>
        </nav>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-10">
          <aside className="hidden lg:block lg:col-span-3">
            <div className="sticky top-6">
              <p className="text-[11px] uppercase tracking-[0.22em] text-ink/55 mb-4">
                Documentation
              </p>
              <nav className="space-y-7">
                {groups.map((g) => (
                  <div key={g.head}>
                    <p className="text-xs font-medium text-ink/85 mb-2">{g.head}</p>
                    <ul className="space-y-1">
                      {g.items.map((it) => (
                        <li key={it.to}>
                          <NavLink
                            to={it.to}
                            end={it.to === '/docs'}
                            className={({ isActive }) =>
                              cn(
                                'block py-1.5 pl-3 -ml-px border-l text-sm transition-colors',
                                isActive
                                  ? 'border-terracotta text-ink font-medium'
                                  : 'border-ink/10 text-ink/60 hover:text-ink hover:border-ink/40',
                              )
                            }
                          >
                            {it.label}
                          </NavLink>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </nav>
            </div>
          </aside>

          <article className="lg:col-span-9 max-w-3xl">
            <Outlet />
          </article>
        </div>
      </div>

      <Footer />
    </div>
  );
}

export function DocLead({
  kicker,
  title,
  intro,
}: {
  kicker: string;
  title: string;
  intro: string;
}) {
  return (
    <header className="mb-8 sm:mb-10 border-b border-ink/10 pb-6 sm:pb-8">
      <span className="text-[10px] sm:text-[11px] uppercase tracking-[0.22em] text-ink/55">{kicker}</span>
      <h1 className="font-display-tight text-4xl sm:text-5xl lg:text-6xl mt-2 sm:mt-3 leading-[1.05]">{title}</h1>
      <p className="mt-4 sm:mt-5 text-base sm:text-lg text-ink/70 leading-relaxed max-w-prose">{intro}</p>
    </header>
  );
}

export function DocSection({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-10 sm:mb-12">
      <h2 className="font-display text-2xl sm:text-3xl mb-3 sm:mb-4">{heading}</h2>
      <div className="prose-content space-y-4 text-ink/80 leading-relaxed">{children}</div>
    </section>
  );
}

export function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="rounded-2xl bg-ink text-paper p-5 overflow-x-auto text-[13px] font-mono leading-relaxed">
      <code>{children}</code>
    </pre>
  );
}
