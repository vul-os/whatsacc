import { PageHeader } from './AppLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

const invoices = [
  { id: 'inv_1041', period: 'Apr 2026', amount: '$9.00', status: 'paid', msgs: 1872 },
  { id: 'inv_1029', period: 'Mar 2026', amount: '$9.00', status: 'paid', msgs: 1654 },
  { id: 'inv_1018', period: 'Feb 2026', amount: '$9.00', status: 'paid', msgs: 1410 },
  { id: 'inv_1004', period: 'Jan 2026', amount: '$9.00', status: 'paid', msgs: 1192 },
];

export default function Billing() {
  return (
    <>
      <PageHeader
        kicker="Account"
        title="Billing"
        description="You're on Starter — $9/month for 2,000 messages. Upgrade when you need more."
        actions={<Button variant="ink">Upgrade plan</Button>}
      />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mb-6">
        <Card tone="ink" className="lg:col-span-5">
          <p className="text-[11px] uppercase tracking-[0.22em] text-paper/55">Current period</p>
          <p className="font-display text-5xl mt-3">1,243</p>
          <p className="text-paper/60 mt-1">of 2,000 messages</p>
          <div className="mt-6 h-2 bg-paper/15 rounded-full overflow-hidden">
            <div className="h-full bg-terracotta" style={{ width: '62%' }} />
          </div>
          <p className="text-xs text-paper/55 mt-3">resets on the 1st</p>
        </Card>

        <Card className="lg:col-span-7">
          <p className="text-[11px] uppercase tracking-[0.22em] text-ink/55">Payment method</p>
          <div className="mt-4 flex items-center gap-4 p-4 rounded-xl border border-ink/10">
            <div className="grid place-items-center h-10 w-14 rounded bg-ink text-paper text-[10px] font-mono tracking-widest">
              VISA
            </div>
            <div>
              <p className="font-medium">•••• 4842</p>
              <p className="text-xs text-ink/55">expires 09 / 28</p>
            </div>
            <button className="ml-auto text-sm text-ink/60 hover:text-ink">Update</button>
          </div>

          <p className="text-[11px] uppercase tracking-[0.22em] text-ink/55 mt-8 mb-3">Billed to</p>
          <p className="text-sm leading-relaxed">
            Yusuf Adams<br />
            Oakridge Estate Management<br />
            Cape Town, ZA
          </p>
        </Card>
      </div>

      <Card className="p-0 overflow-hidden">
        <div className="px-6 py-4 border-b border-ink/10">
          <h2 className="font-display text-2xl">Invoices</h2>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr>
              {['Invoice', 'Period', 'Messages', 'Amount', 'Status', ''].map((c) => (
                <th key={c} className="text-left px-6 py-3 text-[11px] uppercase tracking-[0.18em] text-ink/55 font-normal">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {invoices.map((iv) => (
              <tr key={iv.id} className="border-t border-ink/8">
                <td className="px-6 py-4 font-mono text-xs">{iv.id}</td>
                <td className="px-6 py-4">{iv.period}</td>
                <td className="px-6 py-4 text-ink/70">{iv.msgs.toLocaleString()}</td>
                <td className="px-6 py-4 font-display text-lg">{iv.amount}</td>
                <td className="px-6 py-4">
                  <span className="inline-flex items-center gap-2 text-xs text-moss">
                    <span className="h-1.5 w-1.5 rounded-full bg-moss" />
                    {iv.status}
                  </span>
                </td>
                <td className="px-6 py-4 text-right">
                  <button className="text-xs text-ink/60 hover:text-ink underline underline-offset-4 decoration-terracotta">
                    Download
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
