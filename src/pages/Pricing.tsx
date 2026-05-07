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

      <section className="mx-auto max-w-[1280px] px-6 lg:px-10 pb-24">
        <h2 className="font-display-tight text-4xl mb-8">Compare in detail</h2>
        <div className="overflow-x-auto rounded-3xl border border-ink/10">
          <table className="w-full text-sm">
            <thead className="bg-paper-warm">
              <tr>
                {cols.map((c) => (
                  <th
                    key={c}
                    className="text-left px-5 py-4 text-[11px] uppercase tracking-[0.18em] text-ink/55 font-normal"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tiers.map((row, i) => (
                <tr key={i} className="border-t border-ink/10">
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className={`px-5 py-5 ${j === 0 ? 'font-display text-lg' : 'text-ink/80'}`}
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
