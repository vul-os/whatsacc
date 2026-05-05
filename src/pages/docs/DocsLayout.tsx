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

      <div className="mx-auto max-w-[1280px] px-6 lg:px-10 py-12">
        <div className="grid grid-cols-12 gap-10">
          <aside className="hidden lg:block col-span-3">
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

          <article className="col-span-12 lg:col-span-9 max-w-3xl">
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
    <header className="mb-10 border-b border-ink/10 pb-8">
      <span className="text-[11px] uppercase tracking-[0.22em] text-ink/55">{kicker}</span>
      <h1 className="font-display-tight text-5xl lg:text-6xl mt-3 leading-[1]">{title}</h1>
      <p className="mt-5 text-lg text-ink/70 leading-relaxed max-w-prose">{intro}</p>
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
    <section className="mb-12">
      <h2 className="font-display text-3xl mb-4">{heading}</h2>
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
