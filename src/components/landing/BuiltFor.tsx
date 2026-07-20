import { Neighborhood } from '@/components/illustrations/Neighborhood';

const audiences = [
  {
    tag: 'Homeowners',
    blurb: 'Replace remotes and intercom fobs. Let family text the gate from any phone, anywhere.',
    detail: 'House Bertrand · 1 gate · 4 members',
  },
  {
    tag: 'Residential complexes',
    blurb:
      'Give residents and visitors a working alternative to brittle keypad codes and cloned remotes.',
    detail: 'Oakridge Estate · 4 access points · 124 residents',
  },
  {
    tag: 'Property managers',
    blurb:
      'One dashboard across every property. Move tenants in and out with a phone-number invite.',
    detail: '50 Riebeek + 11 more · one dashboard',
  },
  {
    tag: 'Security companies',
    blurb:
      'Hand out controlled, instantly-revocable access to guards, contractors and rotating staff.',
    detail: 'Audit log every event · revoke in a tap',
  },
];

export function BuiltFor() {
  return (
    <section className="relative bg-ink text-paper">
      <div className="mx-auto max-w-[1280px] px-5 sm:px-6 lg:px-10 py-20 md:py-24">
        <div className="grid grid-cols-12 sm:gap-x-8 gap-y-10 items-end mb-12 md:mb-14">
          <div className="col-span-12 lg:col-span-7">
            <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-paper/55">
              <span className="h-1 w-1 rounded-full bg-terracotta" aria-hidden />
              Built for
            </span>
            <h2 className="mt-4 font-display-tight text-4xl sm:text-5xl lg:text-[64px] leading-[0.96] tracking-[-0.02em]">
              From a single front gate to <em className="italic text-terracotta-soft">a thousand thresholds</em>.
            </h2>
          </div>
          <div className="col-span-12 lg:col-span-5">
            <Neighborhood className="block w-full h-auto max-w-sm mx-auto lg:ml-auto lg:mr-0" />
          </div>
        </div>

        <ul className="grid grid-cols-1 md:grid-cols-2 gap-px bg-paper/10 border border-paper/10 rounded-2xl overflow-hidden">
          {audiences.map((a, i) => (
            <li key={a.tag} className="bg-ink p-7 sm:p-9 relative">
              <span className="numeral absolute top-6 right-6 text-paper/25 text-xs tabular-nums">
                {String(i + 1).padStart(2, '0')}
              </span>
              <h3 className="font-display text-[22px] text-paper pr-10">{a.tag}</h3>
              <p className="mt-3 text-paper/70 leading-relaxed max-w-md text-[15px]">{a.blurb}</p>
              <div className="mt-6 inline-flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-paper/45">
                <span className="h-1 w-1 rounded-full bg-terracotta" />
                {a.detail}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
