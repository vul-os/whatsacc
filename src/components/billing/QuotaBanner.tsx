import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { useFormatZar } from '@/lib/billing/currency';
import { api, type AccountBilling } from '@/lib/api';

/**
 * A small banner that shows remaining included opens or low balance warnings.
 */
export function QuotaBanner({ accountId }: { accountId: string }) {
  const [billing, setBilling] = useState<AccountBilling | null>(null);
  const [loading, setLoading] = useState(true);
  const formatZar = useFormatZar();

  useEffect(() => {
    let cancelled = false;
    api.accountBilling(accountId)
      .then(data => {
        if (!cancelled) {
          setBilling(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [accountId]);

  if (loading || !billing?.subscription) return null;

  const { subscription, wallet } = billing;
  const balance = wallet?.balance_cents ?? 0;
  
  // Note: We don't have the 'used' count directly in the current AccountBilling type,
  // but we can show the Wallet balance and the Plan type.
  // For a more detailed "X opens left", we'd need to update the API.
  
  const isLowBalance = balance < 500; // Less than R5.00

  return (
    <Card className={`mb-6 flex items-center justify-between py-3 px-4 ${isLowBalance ? 'border-terracotta/30 bg-terracotta/5' : 'border-moss/20 bg-moss/5'}`}>
      <div className="flex items-center gap-3">
        <div className={`h-2 w-2 rounded-full ${isLowBalance ? 'bg-terracotta' : 'bg-moss'} animate-pulse`} />
        <div>
          <p className="text-sm font-medium">
            Plan: <span className="capitalize">{subscription.plan_code}</span>
          </p>
          <p className="text-xs text-ink/65">
            {isLowBalance 
              ? "Low wallet balance. Top up soon to avoid interruption." 
              : "Account is active and in good standing."}
          </p>
        </div>
      </div>
      <div className="text-right">
        <p className="text-xs uppercase tracking-widest text-ink/50 mb-0.5">Wallet</p>
        <p className={`font-display text-lg ${isLowBalance ? 'text-terracotta-deep' : 'text-moss-deep'}`}>
          {formatZar(balance / 100)}
        </p>
      </div>
    </Card>
  );
}
