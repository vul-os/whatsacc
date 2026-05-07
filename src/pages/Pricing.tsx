import { TopNav } from '@/components/nav/TopNav';
import { Footer } from '@/components/landing/Footer';
import { Pricing as PricingBlock } from '@/components/landing/Pricing';
import { PricingEstimator } from '@/components/landing/PricingEstimator';
import { useFormatZar } from '@/lib/billing/currency';

// Same canonical-ZAR base as the landing tier card so both stay in sync.
const tiers: Array<[string, number, string, string, string, string, string]> = [
  ['Free',    0,   '100',    '1',         '1',         '30 days',  'Email'],
  ['Starter', 165, '2,000',  '5',         '10',        '12 months','Email + chat'],
  ['Pro',     900, '20,000', 'Unlimited', 'Unlimited', 'Forever',  'Priority + phone'],
];

const cols = ['Plan', 'Monthly', 'Messages', 'Locations', 'Devices', 'Audit retention', 'Support'];

export default function PricingPage() {
  const formatZar = useFormatZar();
  return (
    <div className="bg-paper">
      <TopNav />
      <PricingBlock />
      <PricingEstimator />

      <section className="mx-auto max-w-[1280px] px-5 sm:px-6 lg:px-10 pb-20 md:pb-24">
        <div className="mb-10 md:mb-12">
          <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-ink/55">
            <span className="h-1 w-1 rounded-full bg-terracotta" aria-hidden />
            Compare in detail
          </span>
          <h2 className="mt-4 font-display-tight text-4xl sm:text-5xl leading-[0.96] tracking-[-0.02em]">
            Side by side.
          </h2>
        </div>
        <div className="overflow-x-auto rounded-2xl border border-ink/10 bg-paper-cool/40">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink/10">
                {cols.map((c) => (
                  <th
                    key={c}
                    className="text-left px-5 sm:px-6 py-4 text-[10px] uppercase tracking-[0.22em] text-ink/55 font-normal"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tiers.map((row, i) => (
                <tr
                  key={i}
                  className={`border-t border-ink/8 ${i === 1 ? 'bg-paper-warm/40' : ''}`}
                >
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className={`px-5 sm:px-6 py-5 ${
                        j === 0
                          ? 'font-display text-xl'
                          : j === 1
                            ? 'tabular-nums text-ink font-medium'
                            : 'text-ink/80'
                      }`}
                    >
                      {j === 1 ? formatZar(cell as number) : cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Footer />
    </div>
  );
}
