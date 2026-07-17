// Rate-limit knobs: default / env / override / effective for each of the four
// instance-wide abuse limits. Overrides are editable (blank = clear → null);
// resolution order is db override > env var > built-in default. 0 gets an
// explicit warning treatment: cooldown-off vs full kill switch.

import { useEffect, useState } from 'react';
import {
  api,
  type AdminLimitField,
  type AdminLimitsPatch,
  type AdminLimitsResponse,
} from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { ErrorNote, LoadingRow, Td, Th, adminErrorMessage, useAdminLoad, useAdminToast } from './shared';

const KNOBS: Array<{
  field: AdminLimitField;
  name: string;
  unit: string;
  blurb: string;
  /** what a 0 means for this knob */
  zero: 'off' | 'kill';
}> = [
  {
    field: 'open_cooldown_s',
    name: 'Open cooldown',
    unit: 's',
    blurb: 'Seconds a member must wait between opens of the same access point.',
    zero: 'off',
  },
  {
    field: 'opens_per_hour',
    name: 'Opens / member / hour',
    unit: '/h',
    blurb: 'Successful opens allowed per member each hour, across all their gates.',
    zero: 'kill',
  },
  {
    field: 'chat_msgs_per_min',
    name: 'Chat messages / min',
    unit: '/min',
    blurb: 'Inbound chat messages per sender per minute before the bot goes quiet (flood guard).',
    zero: 'kill',
  },
  {
    field: 'account_opens_per_hour',
    name: 'Opens / account / hour',
    unit: '/h',
    blurb: 'Ceiling on successful opens across a whole account each hour (runaway-integration stop).',
    zero: 'kill',
  },
];

export default function AdminLimits() {
  const toast = useAdminToast();
  const { data, setData, error, loading } = useAdminLoad(() => api.adminLimits(), []);
  // Draft override inputs, keyed by field. '' = no override (null).
  const [draft, setDraft] = useState<Record<AdminLimitField, string>>({
    open_cooldown_s: '',
    opens_per_hour: '',
    chat_msgs_per_min: '',
    account_opens_per_hour: '',
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (data) setDraft(overridesToDraft(data));
  }, [data]);

  if (loading && !data) return <LoadingRow label="Loading limits…" />;
  if (error) return <ErrorNote text={error} />;
  if (!data) return null;

  const patch = buildPatch(data, draft);
  const dirty = Object.keys(patch).length > 0;
  const invalid = KNOBS.some((k) => !isValidDraft(draft[k.field]));

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      const next = await api.adminLimitsUpdate(patch);
      setData(next);
      toast('Limits saved — effective immediately on every open path.');
    } catch (err) {
      setSaveError(adminErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-0 overflow-hidden">
        <div className="px-5 pt-5 pb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-display text-xl">Abuse-protection limits</h2>
            <p className="text-xs text-ink/55 mt-1 max-w-xl leading-relaxed">
              Resolution per knob: <span className="font-mono">override&nbsp;&gt;&nbsp;env&nbsp;&gt;&nbsp;default</span>.
              Overrides persist in the database and apply instantly — leave a field blank to fall
              back to the env/default value.
            </p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink/10">
                <Th>Limit</Th>
                <Th className="text-right">Default</Th>
                <Th className="text-right">Env</Th>
                <Th className="text-right">Override</Th>
                <Th className="text-right">Effective</Th>
              </tr>
            </thead>
            <tbody>
              {KNOBS.map((k) => {
                const eff = data.effective[k.field];
                const overridden = data.overrides[k.field] !== null;
                const draftInvalid = !isValidDraft(draft[k.field]);
                return (
                  <tr key={k.field} className="border-b border-ink/8 last:border-0">
                    <Td>
                      <p className="font-medium">{k.name}</p>
                      <p className="text-xs text-ink/55 mt-0.5 max-w-md leading-relaxed">{k.blurb}</p>
                      <p className="font-mono text-[10px] text-ink/35 mt-1">{k.field}</p>
                    </Td>
                    <Td className="text-right font-mono tabular-nums text-ink/55">
                      {data.defaults[k.field].toLocaleString()}
                    </Td>
                    <Td className="text-right font-mono tabular-nums text-ink/55">
                      {data.env[k.field].toLocaleString()}
                    </Td>
                    <Td className="text-right">
                      <input
                        inputMode="numeric"
                        value={draft[k.field]}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, [k.field]: e.target.value }))
                        }
                        placeholder="—"
                        aria-label={`${k.name} override`}
                        className={cn(
                          'h-9 w-24 rounded-lg border bg-paper-cool px-2.5 text-right font-mono text-sm tabular-nums focus:outline-none focus:ring-2 transition-colors',
                          draftInvalid
                            ? 'border-terracotta/60 focus:ring-terracotta/30'
                            : 'border-ink/15 focus:ring-ink/20 focus:border-ink/40',
                        )}
                      />
                    </Td>
                    <Td className="text-right">
                      <span
                        className={cn(
                          'font-mono text-base tabular-nums',
                          eff === 0 ? 'text-terracotta-deep font-semibold' : 'text-ink',
                          overridden && eff !== 0 && 'text-gold',
                        )}
                      >
                        {eff.toLocaleString()}
                        <span className="text-[10px] text-ink/40 ml-1">{k.unit}</span>
                      </span>
                      {eff === 0 && (
                        <span
                          className={cn(
                            'block mt-1 text-[10px] uppercase tracking-[0.14em]',
                            k.zero === 'off' ? 'text-gold' : 'text-terracotta-deep',
                          )}
                        >
                          {k.zero === 'off' ? '0 = cooldown off' : '0 = kill switch — blocks all'}
                        </span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="px-5 py-4 border-t border-ink/10 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-ink/50">
            {invalid
              ? 'Overrides must be whole numbers ≥ 0.'
              : dirty
                ? `${Object.keys(patch).length} change${Object.keys(patch).length === 1 ? '' : 's'} pending`
                : 'No pending changes.'}
            {saveError && <span className="text-terracotta-deep ml-2">{saveError}</span>}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!dirty || saving}
              onClick={() => setDraft(overridesToDraft(data))}
              className="h-9 px-4 rounded-full text-sm text-ink/60 hover:text-ink disabled:opacity-35 disabled:pointer-events-none"
            >
              Reset
            </button>
            <Button variant="ink" size="sm" disabled={!dirty || invalid || saving} onClick={save}>
              {saving ? 'Saving…' : 'Save overrides'}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function overridesToDraft(data: AdminLimitsResponse): Record<AdminLimitField, string> {
  const out = {} as Record<AdminLimitField, string>;
  for (const k of KNOBS) {
    const v = data.overrides[k.field];
    out[k.field] = v === null ? '' : String(v);
  }
  return out;
}

function isValidDraft(s: string): boolean {
  const t = s.trim();
  if (t === '') return true;
  return /^\d+$/.test(t) && Number(t) <= 1_000_000_000;
}

/** Only send fields whose draft differs from the stored override. */
function buildPatch(
  data: AdminLimitsResponse,
  draft: Record<AdminLimitField, string>,
): AdminLimitsPatch {
  const patch: AdminLimitsPatch = {};
  for (const k of KNOBS) {
    const t = draft[k.field].trim();
    if (!isValidDraft(t)) continue;
    const next = t === '' ? null : Number(t);
    if (next !== data.overrides[k.field]) patch[k.field] = next;
  }
  return patch;
}
