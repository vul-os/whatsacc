// Pricing estimator for whatsacc.
//
// All values returned by `estimate()` are in ZAR (rounded to nearest integer).
// The display layer is responsible for converting to the user's chosen
// display currency via `formatCurrency` from `./data`.

import type { Country } from './data';

const ARPU_ZAR = 22; // per resident per month for the Custom tier
const BASE_SUBSCRIPTION_ZAR = 349; // Starter floor
const PRO_BASE_ZAR = 999; // Pro floor (also the floor for Custom)
const EXTRA_DEVICE_ZAR = 49; // each access point beyond INCLUDED_DEVICES
const FREE_CONVERSATIONS = 1000; // Meta's free tier per business / month
const INCLUDED_DEVICES = 5;

export type Plan = 'Free' | 'Starter' | 'Pro' | 'Custom';

export type Estimate = {
  plan: Plan;
  conversations: number;
  billableConversations: number;
  planPriceZar: number;
  extraDevicesZar: number;
  msgCostZar: number;
  totalZar: number;
  perResidentZar: number;
};

export type EstimateInput = {
  country: Country;
  residents: number;
  accessPoints: number;
  /** Average opens per resident per day. Defaults to 2. */
  opensPerDay?: number;
};

/**
 * Resolve plan + plan price for the given monthly conversation volume.
 */
function resolvePlan(conversations: number, residents: number): { plan: Plan; price: number } {
  if (conversations <= 100) return { plan: 'Free', price: 0 };
  if (conversations <= 2000) return { plan: 'Starter', price: BASE_SUBSCRIPTION_ZAR };
  if (conversations <= 20000) return { plan: 'Pro', price: PRO_BASE_ZAR };
  return { plan: 'Custom', price: Math.max(ARPU_ZAR * residents, PRO_BASE_ZAR) };
}

export function estimate(args: EstimateInput): Estimate {
  const { country, residents, accessPoints } = args;
  const opensPerDay = args.opensPerDay ?? 2;

  const conversations = Math.max(0, Math.round(residents * opensPerDay * 30));
  const billableConversations = Math.max(0, conversations - FREE_CONVERSATIONS);

  const { plan, price: planPriceZar } = resolvePlan(conversations, residents);

  const extraDevicesZar = Math.max(0, accessPoints - INCLUDED_DEVICES) * EXTRA_DEVICE_ZAR;

  // Free + Starter absorb msg cost into the plan; Pro + Custom pass it through.
  const msgCostZar =
    plan === 'Free' || plan === 'Starter' ? 0 : billableConversations * country.msgCostZar;

  const totalZar = planPriceZar + extraDevicesZar + msgCostZar;
  const perResidentZar = residents > 0 ? totalZar / residents : 0;

  return {
    plan,
    conversations,
    billableConversations,
    planPriceZar: Math.round(planPriceZar),
    extraDevicesZar: Math.round(extraDevicesZar),
    msgCostZar: Math.round(msgCostZar),
    totalZar: Math.round(totalZar),
    perResidentZar: Math.round(perResidentZar),
  };
}
