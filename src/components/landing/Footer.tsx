import { Link } from 'react-router-dom';
import { ArchMark } from '@/components/illustrations/ArchMark';

const cols = [
  {
    head: 'Product',
    links: [
      { to: '/', label: 'Overview' },
      { to: '/pricing', label: 'Pricing' },
      { to: '/security', label: 'Security' },
    ],
  },
  {
    head: 'Builders',
    links: [
      { to: '/docs', label: 'Documentation' },
      { to: '/docs/api-reference', label: 'API reference' },
      { to: '/docs/pairing-device', label: 'Hardware setup' },
    ],
  },
  {
    head: 'Account',
    links: [
      { to: '/login', label: 'Login' },
      { to: '/signup', label: 'Sign up' },
      { to: '/app', label: 'Open the app' },
    ],
  },
];

export function Footer() {
  return (
    <footer className="relative bg-ink text-paper">
      <div className="mx-auto max-w-[1280px] px-5 sm:px-6 lg:px-10 pt-16 sm:pt-20 pb-10">
        <div className="grid grid-cols-12 gap-x-6 gap-y-10">
          <div className="col-span-12 lg:col-span-5">
            <Link to="/" className="inline-flex items-center gap-3" aria-label="whatsacc home">
              <span className="grid h-12 w-12 sm:h-14 sm:w-14 place-items-center rounded-xl bg-paper/5 border border-paper/10">
                <ArchMark className="h-8 w-8 sm:h-9 sm:w-9 text-paper" />
              </span>
              <span className="font-display italic text-4xl sm:text-5xl leading-none">whatsacc</span>
            </Link>
            <p className="mt-5 sm:mt-6 text-paper/65 max-w-sm leading-relaxed">
              A quieter way through the threshold. Built in Cape Town, deployed wherever
              there&rsquo;s a gate that needs opening.
            </p>
          </div>

          {cols.map((c) => (
            <div key={c.head} className="col-span-6 sm:col-span-4 lg:col-span-2">
              <p className="text-[11px] uppercase tracking-[0.22em] text-paper/45 mb-4">
                {c.head}
              </p>
              <ul className="space-y-2.5">
                {c.links.map((l) => (
                  <li key={l.to}>
                    <Link to={l.to} className="text-paper/80 hover:text-paper text-sm">
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <div className="col-span-12 sm:col-span-12 lg:col-span-1">
            <p className="text-[11px] uppercase tracking-[0.22em] text-paper/45 mb-4">Reach</p>
            <a
              href="mailto:hello@whatsacc.io"
              className="text-sm text-paper/80 hover:text-paper break-all"
            >
              hello@whatsacc.io
            </a>
          </div>
        </div>

        <div className="mt-12 sm:mt-16 pt-6 border-t border-paper/15 flex flex-wrap items-center gap-x-5 gap-y-2 text-[10px] sm:text-[11px] uppercase tracking-[0.22em] text-paper/55">
          <span>&copy; {new Date().getFullYear()} whatsacc</span>
          <span aria-hidden>&mdash;</span>
          <span>texts that open gates</span>
          <span className="ml-auto">v 0.1 &middot; cape town</span>
        </div>
      </div>
    </footer>
  );
}
