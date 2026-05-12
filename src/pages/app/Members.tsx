import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PageHeader } from './AppLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useAuth } from '@/lib/auth';
import { ApiError, api, type AccountMemberRow } from '@/lib/api';

const roleStyles: Record<AccountMemberRow['role'], string> = {
  owner: 'bg-ink text-paper',
  admin: 'bg-terracotta text-paper',
  member: 'bg-paper-warm text-ink border border-ink/10',
  viewer: 'bg-gold/30 text-ink',
};

function initials(name: string | null, email: string): string {
  const source = name && name.trim().length > 0 ? name : email.split('@')[0] ?? email;
  return source
    .split(/[\s.+_-]+/)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 2);
}

export default function MembersPage() {
  const { currentAccount } = useAuth();
  const [members, setMembers] = useState<AccountMemberRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  const refresh = useCallback(async () => {
    if (!currentAccount) return;
    try {
      const r = await api.accountMembers(currentAccount.id);
      setMembers(r.members);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load members.');
    }
  }, [currentAccount]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!currentAccount) {
    return (
      <>
        <PageHeader kicker="People" title="Members" />
        <Card>
          <p className="text-ink/65 text-sm">No account loaded.</p>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        kicker="People"
        title="Members"
        description="Anyone with a role on this account. Invite by email — they'll get a link to accept."
        actions={
          <Button variant="ink" onClick={() => setInviting(true)}>
            Invite member
          </Button>
        }
      />

      {error && (
        <Card className="mb-6 border-terracotta/40">
          <p className="text-sm text-terracotta-deep">{error}</p>
        </Card>
      )}

      {members === null ? (
        <Card>
          <p className="text-ink/55 text-sm">Loading…</p>
        </Card>
      ) : members.length === 0 ? (
        <Card>
          <p className="text-ink/65 text-sm">No members yet — that's unusual, you should at least be in here.</p>
        </Card>
      ) : (
        <Card className="p-0 overflow-hidden">
          {/* Mobile: card list. Tables don't fit comfortably on phones, and the
              email column was the main offender. */}
          <ul className="md:hidden divide-y divide-ink/10">
            {members.map((m) => (
              <li key={m.user_id} className="p-4 flex items-start gap-3">
                <span className="grid h-9 w-9 place-items-center rounded-full bg-ink/10 text-ink text-xs font-medium shrink-0">
                  {initials(m.display_name, m.email)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium truncate">
                    {m.display_name ?? m.email.split('@')[0]}
                  </p>
                  <p className="text-xs text-ink/60 truncate mt-0.5">{m.email}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] ${roleStyles[m.role]}`}
                    >
                      {m.role}
                    </span>
                    <span className="text-[11px] text-ink/60 capitalize">{m.status}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {/* md+: full table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink/10">
                  {['Name', 'Email', 'Role', 'Status'].map((c) => (
                    <th
                      key={c}
                      className="text-left px-6 py-4 text-[11px] uppercase tracking-[0.18em] text-ink/55 font-normal"
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr
                    key={m.user_id}
                    className="border-b border-ink/8 last:border-0 hover:bg-paper-warm/40 transition-colors"
                  >
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <span className="grid h-8 w-8 place-items-center rounded-full bg-ink/10 text-ink text-xs font-medium">
                          {initials(m.display_name, m.email)}
                        </span>
                        <span className="font-medium">{m.display_name ?? m.email.split('@')[0]}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-ink/70">{m.email}</td>
                    <td className="px-6 py-4">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] ${roleStyles[m.role]}`}
                      >
                        {m.role}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-ink/65 capitalize">{m.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {inviting && (
        <InviteModal
          accountId={currentAccount.id}
          onClose={() => setInviting(false)}
          onInvited={() => {
            setInviting(false);
            refresh();
          }}
        />
      )}
    </>
  );
}

function InviteModal({
  accountId,
  onClose,
  onInvited,
}: {
  accountId: string;
  onClose: () => void;
  onInvited: () => void;
}) {
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('+');
  const [role, setRole] = useState<AccountMemberRow['role']>('member');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [delivery, setDelivery] = useState<{ email: boolean; whatsapp: boolean } | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setSubmitting(true);
    try {
      const result = await api.inviteCreate(accountId, {
        email: email.trim().toLowerCase(),
        phone_e164: phone.replace(/\s+/g, ''),
        role,
      });
      setDelivery({ email: result.email_sent, whatsapp: result.whatsapp_sent });
      setSent(true);
    } catch (err) {
      const msg = err instanceof ApiError 
        ? (err.detail ?? err.code) 
        : err instanceof Error 
          ? err.message 
          : 'Failed.';
      setErrorMsg(typeof msg === 'string' ? msg : 'An unexpected error occurred.');
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={onClose}>
      <h2 className="font-display text-2xl mb-1">{sent ? 'Invite sent' : 'Invite a member'}</h2>
      {sent ? (
        <>
          <p className="text-sm text-ink/65 mt-2">
            We've sent the invite to <span className="font-medium">{email}</span> and{' '}
            <span className="font-medium">{phone}</span>. It expires in 7 days.
          </p>
          {delivery && (!delivery.email || !delivery.whatsapp) && (
            <p className="text-xs text-terracotta-deep mt-3">
              {delivery.email ? '' : 'Email delivery failed. '}
              {delivery.whatsapp ? '' : 'WhatsApp delivery failed. '}
              The invite was still created.
            </p>
          )}
          <div className="flex justify-end mt-6">
            <Button variant="ink" onClick={onInvited}>
              Done
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-ink/60 mb-5">
            They'll get an email and WhatsApp with a link to accept.
          </p>
          <form onSubmit={onSubmit} className="space-y-4">
            <label className="block">
              <span className="text-sm font-medium text-ink/85">Email</span>
              <input
                type="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="member@example.com"
                className="mt-1.5 w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
              />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-ink/85">Phone Number (E.164)</span>
              <input
                type="tel"
                required
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+27..."
                className="mt-1.5 w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
              />
              <p className="text-[11px] text-ink/50 mt-1">Must include country code, e.g. +27821234567</p>
            </label>
            <fieldset>
              <legend className="text-sm font-medium text-ink/85 mb-2">Role</legend>
              <div className="grid grid-cols-4 gap-2">
                {(['admin', 'member', 'viewer'] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRole(r)}
                    className={`h-10 rounded-xl border text-xs capitalize transition-colors ${
                      role === r
                        ? 'bg-ink text-paper border-ink'
                        : 'bg-paper-cool text-ink border-ink/15 hover:border-ink/35'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </fieldset>
            {errorMsg && <p className="text-sm text-terracotta-deep">{errorMsg}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="h-10 px-4 rounded-full text-sm text-ink/65 hover:text-ink"
              >
                Cancel
              </button>
              <Button type="submit" variant="ink" disabled={submitting}>
                {submitting ? 'Sending…' : 'Send invite'}
              </Button>
            </div>
          </form>
        </>
      )}
    </Modal>
  );
}
