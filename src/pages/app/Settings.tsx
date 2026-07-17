import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from './AppLayout';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Avatar, resolveAvatarUrl } from '@/components/ui/Avatar';
import { ApiError, api, type LocationRow } from '@/lib/api';
import { useAuth } from '@/lib/auth';

export default function Settings() {
  const { currentAccount, user } = useAuth();
  // OAuth-only accounts (Google sign-in) have no password to change. Show a
  // small explainer instead of an empty/broken password form.
  const hasPassword = user?.has_password ?? false;

  return (
    <>
      <PageHeader
        kicker="Settings"
        title={currentAccount?.name ?? 'Settings'}
        description={
          hasPassword
            ? 'Rename or remove this location, and manage your account password.'
            : 'Rename or remove this location, and manage your sign-in identity.'
        }
      />
      <div className="grid grid-cols-1 gap-6 max-w-3xl">
        <ProfileSection />
        <ContactSection />
        <LocationsSection />
        {hasPassword ? <PasswordSection /> : <SignInIdentitySection />}
      </div>
    </>
  );
}

// Calm explainer for users who signed in with Google and have no password
// set. Tells them how to add one if they want a fallback.
function SignInIdentitySection() {
  return (
    <Card>
      <h2 className="font-display text-xl mb-1">Sign-in</h2>
      <p className="text-sm text-ink/55 mb-4">
        You signed in with Google. There is no password on this account, so there is nothing to
        change here.
      </p>
      <div className="rounded-xl bg-paper-cool border border-ink/10 px-4 py-3 text-[13.5px] text-ink/75 leading-relaxed">
        Want a password as a backup sign-in method? Use the{' '}
        <a
          href="/forgot-password"
          className="underline underline-offset-4 decoration-terracotta text-ink hover:text-terracotta-deep"
        >
          forgot-password
        </a>{' '}
        flow with this email — you&rsquo;ll set a password without unlinking Google. Both
        methods will then work.
      </div>
    </Card>
  );
}

function ProfileSection() {
  const { user, refreshMe } = useAuth();
  const [displayName, setDisplayName] = useState(user?.name ?? '');
  const [avatarUrl, setAvatarUrl] = useState(user?.avatar_url ?? '');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Keep local state in sync when the user record refreshes (e.g. after a
  // Google sign-in refreshes the avatar from Google).
  useEffect(() => { setDisplayName(user?.name ?? ''); }, [user?.name]);
  useEffect(() => { setAvatarUrl(user?.avatar_url ?? ''); }, [user?.avatar_url]);

  const sourceLabel =
    user?.avatar_source === 'user'
      ? 'Set by you'
      : user?.avatar_source === 'google'
        ? 'From your Google account · refreshed on each sign-in'
        : 'No avatar set';

  async function save(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    setErrorMsg(null);
    const trimmedName = displayName.trim();
    const trimmedUrl = avatarUrl.trim();

    if (trimmedName.length === 0) {
      setErrorMsg('Display name cannot be empty.');
      return;
    }
    if (trimmedUrl.length > 0 && !/^https:\/\//i.test(trimmedUrl)) {
      setErrorMsg('Avatar URL must start with https://');
      return;
    }

    setSaving(true);
    try {
      const body: { display_name?: string; avatar_url?: string | null } = {};
      if (trimmedName !== (user?.name ?? '')) body.display_name = trimmedName;
      if (trimmedUrl !== (user?.avatar_url ?? '')) {
        body.avatar_url = trimmedUrl.length === 0 ? null : trimmedUrl;
      }
      if (Object.keys(body).length === 0) {
        setMessage('Nothing to save.');
      } else {
        await api.profileUpdate(body);
        await refreshMe();
        setMessage('Profile saved.');
      }
    } catch (err) {
      setErrorMsg(toApiMessage(err, 'Could not save profile.'));
    } finally {
      setSaving(false);
    }
  }

  async function resetToGoogle() {
    setMessage(null);
    setErrorMsg(null);
    setSaving(true);
    try {
      await api.profileUpdate({ avatar_url: null });
      await refreshMe();
      setMessage('Avatar cleared — sign out and back in with Google to refresh.');
    } catch (err) {
      setErrorMsg(toApiMessage(err, 'Could not reset avatar.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <h2 className="font-display text-xl mb-1">Your profile</h2>
      <p className="text-sm text-ink/55 mb-5">
        How you appear inside whatsacc. Avatar can be any https URL — Google picture, Gravatar,
        a hosted image, anywhere.
      </p>

      <form onSubmit={save} className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-x-6 gap-y-5 items-start">
        <div className="flex flex-col items-center gap-2 sm:items-start">
          <Avatar
            url={avatarUrl.trim() || resolveAvatarUrl(user) || null}
            name={displayName || user?.email || null}
            size="xl"
            toneClass="bg-ink text-paper"
          />
          <span className="text-[10px] uppercase tracking-[0.18em] text-ink/45 max-w-[160px] text-center sm:text-left leading-snug">
            {sourceLabel}
          </span>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="text-sm font-medium text-ink/85 block mb-1.5">Display name</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
              maxLength={80}
              className="w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] text-ink focus:outline-none focus:ring-2 focus:ring-ink/20 focus:border-ink/40"
            />
          </label>

          <label className="block">
            <span className="flex items-baseline justify-between mb-1.5">
              <span className="text-sm font-medium text-ink/85">Avatar URL</span>
              <span className="text-xs text-ink/45">https only · leave empty to use Google</span>
            </span>
            <input
              type="url"
              inputMode="url"
              value={avatarUrl}
              onChange={(e) => setAvatarUrl(e.target.value)}
              placeholder="https://example.com/me.png"
              maxLength={1024}
              className="w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] text-ink placeholder:text-ink/35 focus:outline-none focus:ring-2 focus:ring-ink/20 focus:border-ink/40"
            />
          </label>

          {message && <p className="text-sm text-moss" role="status">{message}</p>}
          {errorMsg && <p className="text-sm text-terracotta-deep" role="alert">{errorMsg}</p>}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button type="submit" variant="ink" disabled={saving}>
              {saving ? 'Saving…' : 'Save profile'}
            </Button>
            {user?.avatar_source === 'user' && (
              <button
                type="button"
                onClick={resetToGoogle}
                disabled={saving}
                className="h-10 px-4 rounded-full text-sm text-ink/65 hover:text-ink"
              >
                Reset to Google picture
              </button>
            )}
          </div>
        </div>
      </form>
    </Card>
  );
}

function ContactSection() {
  const { user, refreshMe } = useAuth();
  const [phones, setPhones] = useState<Array<{ id: string; phone_e164: string; verified_at: string | null; is_primary: boolean }> | null>(null);
  const [phone, setPhone] = useState('');
  const [slack, setSlack] = useState(user?.slack_user_id ?? user?.slack_handle ?? '');
  const [savingPhone, setSavingPhone] = useState(false);
  const [savingSlack, setSavingSlack] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const refreshPhones = useCallback(async () => {
    try {
      const r = await api.phones();
      setPhones(r.phones);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not load phone numbers.');
    }
  }, []);

  useEffect(() => {
    refreshPhones();
  }, [refreshPhones]);

  useEffect(() => {
    setSlack(user?.slack_user_id ?? user?.slack_handle ?? '');
  }, [user?.slack_handle, user?.slack_user_id]);

  async function savePhone(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    setErrorMsg(null);
    const trimmed = phone.replace(/\s+/g, '');
    if (!/^\+[1-9]\d{6,14}$/.test(trimmed)) {
      setErrorMsg('Use E.164 format, for example +27821234567.');
      return;
    }
    setSavingPhone(true);
    try {
      await api.phoneAdd({ phone_e164: trimmed, is_primary: true });
      setPhone('');
      await refreshPhones();
      await refreshMe();
      setMessage('WhatsApp number saved.');
    } catch (err) {
      setErrorMsg(toApiMessage(err, 'Could not save WhatsApp number.'));
    } finally {
      setSavingPhone(false);
    }
  }

  async function saveSlack(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    setErrorMsg(null);
    const trimmed = slack.trim().replace(/^@+/, '');
    if (!trimmed) {
      setErrorMsg('Enter your Slack user ID or handle.');
      return;
    }
    const upper = trimmed.toUpperCase();
    const body = /^[UW][A-Z0-9]{2,32}$/.test(upper)
      ? { slack_user_id: upper }
      : { slack_handle: trimmed };
    setSavingSlack(true);
    try {
      await api.slackUpdate(body);
      await refreshMe();
      setMessage('Slack identity saved.');
    } catch (err) {
      setErrorMsg(toApiMessage(err, 'Could not save Slack identity.'));
    } finally {
      setSavingSlack(false);
    }
  }

  return (
    <Card>
      <h2 className="font-display text-2xl">Contact channels</h2>
      <p className="text-sm text-ink/65 mt-1">
        Add WhatsApp and Slack details for chat-based access and bot menus.
      </p>

      {message && <p className="mt-4 text-sm text-moss">{message}</p>}
      {errorMsg && <p className="mt-4 text-sm text-terracotta-deep">{errorMsg}</p>}

      <div className="mt-6 grid gap-6">
        <form onSubmit={savePhone} className="rounded-xl border border-ink/10 bg-paper/45 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="block flex-1">
              <span className="text-sm font-medium text-ink/85">WhatsApp number</span>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+27821234567"
                className="mt-1.5 w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
              />
            </label>
            <Button type="submit" variant="ink" disabled={savingPhone}>
              {savingPhone ? 'Saving…' : 'Save number'}
            </Button>
          </div>
          <div className="mt-4 text-sm text-ink/65">
            {phones === null ? (
              'Loading saved numbers…'
            ) : phones.length === 0 ? (
              'No WhatsApp number saved.'
            ) : (
              <ul className="space-y-1">
                {phones.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-ink">{p.phone_e164}</span>
                    {p.is_primary && <span className="text-[10px] uppercase tracking-[0.18em] text-ink/45">primary</span>}
                    <span className={p.verified_at ? 'text-moss' : 'text-gold'}>
                      {p.verified_at ? 'verified' : 'pending'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </form>

        <form onSubmit={saveSlack} className="rounded-xl border border-ink/10 bg-paper/45 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="block flex-1">
              <span className="text-sm font-medium text-ink/85">Slack ID or handle</span>
              <input
                value={slack}
                onChange={(e) => setSlack(e.target.value)}
                placeholder="@name or U123ABC"
                className="mt-1.5 w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
              />
            </label>
            <Button type="submit" variant="ink" disabled={savingSlack}>
              {savingSlack ? 'Saving…' : 'Save Slack'}
            </Button>
          </div>
          <p className="mt-3 text-sm text-ink/65">
            Current:{' '}
            <span className="font-mono text-ink">
              {user?.slack_user_id ?? (user?.slack_handle ? `@${user.slack_handle}` : 'not set')}
            </span>
          </p>
        </form>
      </div>
    </Card>
  );
}

function toApiMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError
    ? (err.detail ?? err.code)
    : err instanceof Error
      ? err.message
      : fallback;
}

function LocationsSection() {
  const { currentAccount, refreshMe } = useAuth();
  const [rows, setRows] = useState<LocationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentAccount) return;
    try {
      const r = await api.locationsList(currentAccount.id);
      setRows(r.locations);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load locations.');
    }
  }, [currentAccount]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (!currentAccount) {
    return (
      <Card>
        <p className="text-ink/65 text-sm">No account loaded.</p>
      </Card>
    );
  }

  return (
    <Card>
      <h2 className="font-display text-2xl">Locations</h2>
      <p className="text-sm text-ink/65 mt-1">
        Each location has its own access points, members, and devices. Use the account switcher in
        the top bar to add a new one.
      </p>

      {error && (
        <p className="mt-4 text-sm text-terracotta-deep" role="alert">
          {error}
        </p>
      )}

      {rows === null ? (
        <p className="mt-6 text-sm text-ink/55">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="mt-6 text-sm text-ink/65">
          No locations yet. Use the account switcher to create one.
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-ink/10 -mx-1">
          {rows.map((l) => (
            <LocationRowItem
              key={l.id}
              row={l}
              onChanged={refresh}
              afterDelete={async () => {
                await refreshMe();
                await refresh();
              }}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function LocationRowItem({
  row,
  onChanged,
  afterDelete,
}: {
  row: LocationRow;
  onChanged: () => Promise<void> | void;
  afterDelete: () => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  return (
    <li className="px-1 py-4 flex items-center gap-4">
      <span className={`flex-none h-2 w-2 rounded-full ${KIND_DOT[row.type]}`} aria-hidden />
      <div className="flex-1 min-w-0">
        <p className="font-medium text-ink truncate">{row.name}</p>
        <p className="text-[11px] uppercase tracking-[0.18em] text-ink/55 mt-0.5">
          {row.type}
          {row.address?.city ? ` · ${row.address.city}` : ''}
          {' · '}
          {row.access_point_count} pt{row.access_point_count === 1 ? '' : 's'} ·{' '}
          {row.member_count} member{row.member_count === 1 ? '' : 's'}
        </p>
      </div>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-xs text-ink/65 hover:text-ink underline underline-offset-4"
      >
        Rename
      </button>
      <button
        type="button"
        onClick={() => setDeleting(true)}
        className="text-xs text-terracotta-deep hover:underline underline-offset-4"
      >
        Delete
      </button>

      {editing && (
        <RenameLocationModal
          row={row}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await onChanged();
          }}
        />
      )}
      {deleting && (
        <DeleteLocationModal
          row={row}
          onClose={() => setDeleting(false)}
          onDeleted={async () => {
            setDeleting(false);
            await afterDelete();
          }}
        />
      )}
    </li>
  );
}

const KIND_DOT: Record<LocationRow['type'], string> = {
  house: 'bg-gold',
  complex: 'bg-terracotta',
  building: 'bg-moss',
  other: 'bg-slate',
};

function RenameLocationModal({
  row,
  onClose,
  onSaved,
}: {
  row: LocationRow;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const [name, setName] = useState(row.name);
  const [city, setCity] = useState(typeof row.address?.city === 'string' ? row.address.city : '');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    if (!name.trim()) {
      setErrorMsg('Name is required.');
      return;
    }
    setSubmitting(true);
    try {
      const trimmedCity = city.trim();
      const nextAddress = { ...(row.address ?? {}) };
      if (trimmedCity) nextAddress.city = trimmedCity;
      else delete nextAddress.city;
      await api.locationUpdate(row.id, {
        name: name.trim(),
        address: nextAddress,
      });
      await onSaved();
    } catch (err) {
      setErrorMsg(
        err instanceof ApiError
          ? (err.detail ?? err.code)
          : err instanceof Error
            ? err.message
            : 'Update failed.',
      );
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={onClose}>
      <h2 className="font-display text-2xl mb-1">Rename location</h2>
      <p className="text-sm text-ink/60 mb-5">
        Updating the name only changes the label — members, devices, and access points stay attached.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <label className="block">
          <span className="text-sm font-medium text-ink/85">Name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1.5 w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
          />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-ink/85">City (optional)</span>
          <input
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder="Durban"
            className="mt-1.5 w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
          />
        </label>
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
            {submitting ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteLocationModal({
  row,
  onClose,
  onDeleted,
}: {
  row: LocationRow;
  onClose: () => void;
  onDeleted: () => Promise<void> | void;
}) {
  const [confirmText, setConfirmText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const matches = confirmText.trim() === row.name;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!matches) return;
    setErrorMsg(null);
    setSubmitting(true);
    try {
      await api.locationDelete(row.id);
      await onDeleted();
    } catch (err) {
      setErrorMsg(
        err instanceof ApiError
          ? (err.detail ?? err.code)
          : err instanceof Error
            ? err.message
            : 'Delete failed.',
      );
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={onClose}>
      <h2 className="font-display text-2xl text-terracotta-deep mb-1">Delete location</h2>
      <p className="text-sm text-ink/75 mb-3">
        This permanently removes <span className="font-medium text-ink">{row.name}</span> and
        everything attached to it.
      </p>
      <ul className="text-sm text-ink/70 list-disc pl-5 mb-4 space-y-1">
        <li>{row.access_point_count} access point{row.access_point_count === 1 ? '' : 's'}, paired devices, and grants.</li>
        <li>{row.member_count} member{row.member_count === 1 ? '' : 's'} and their access history.</li>
        <li>If this is your last location, the account itself is dropped too.</li>
      </ul>
      <p className="text-sm text-ink/75 mb-4">
        This cannot be undone. Type <span className="font-mono text-ink">{row.name}</span> to confirm.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <input
          autoFocus
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={row.name}
          className="w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] focus:outline-none focus:ring-2 focus:ring-terracotta"
        />
        {errorMsg && <p className="text-sm text-terracotta-deep">{errorMsg}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 px-4 rounded-full text-sm text-ink/65 hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!matches || submitting}
            className="h-11 px-5 rounded-full bg-terracotta-deep text-paper text-sm font-medium hover:bg-terracotta disabled:bg-ink/15 disabled:text-ink/40 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? 'Deleting…' : 'Delete location'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PasswordSection() {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    if (next.length < 8) {
      setErrorMsg('New password must be at least 8 characters.');
      return;
    }
    if (next !== confirm) {
      setErrorMsg('New passwords don’t match.');
      return;
    }
    setSubmitting(true);
    try {
      await api.updatePassword(current, next);
      setDone(true);
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.code === 'invalid_current_password'
            ? 'Current password is incorrect.'
            : err.code === 'same_password'
              ? 'New password must be different from the current one.'
              : err.code === 'no_password_set'
                ? 'This account uses Google sign-in. Set a password from the security flow.'
                : (err.detail ?? err.code)
          : err instanceof Error
            ? err.message
            : 'Could not update password.';
      setErrorMsg(msg);
    } finally {
      setSubmitting(false);
    }
  }

  async function signOutEverywhere() {
    await signOut();
    navigate('/login', { replace: true });
  }

  return (
    <Card>
      <h2 className="font-display text-2xl">Password</h2>
      <p className="text-sm text-ink/65 mt-1">
        Updating signs out every other session — this one stays.
      </p>

      {done && (
        <div className="mt-5 rounded-xl bg-moss/10 border border-moss/30 px-4 py-3 text-sm text-ink/85">
          Password updated. You stay signed in here; other sessions are gone.
        </div>
      )}

      <form onSubmit={onSubmit} className="mt-5 space-y-4">
        <Field
          label="Current password"
          value={current}
          onChange={setCurrent}
          type="password"
          autoComplete="current-password"
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field
            label="New password"
            value={next}
            onChange={setNext}
            type="password"
            autoComplete="new-password"
            hint="8+ chars"
          />
          <Field
            label="Confirm new password"
            value={confirm}
            onChange={setConfirm}
            type="password"
            autoComplete="new-password"
          />
        </div>

        {errorMsg && (
          <p className="text-sm text-terracotta-deep" role="alert">
            {errorMsg}
          </p>
        )}

        <div className="flex flex-wrap gap-3 pt-2">
          <Button type="submit" variant="ink" disabled={submitting}>
            {submitting ? 'Updating…' : 'Update password'}
          </Button>
          <button
            type="button"
            onClick={signOutEverywhere}
            className="h-11 px-5 rounded-full text-sm text-ink/65 hover:text-terracotta-deep underline underline-offset-4"
          >
            Sign out of this session
          </button>
        </div>
      </form>
    </Card>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  type = 'text',
  autoComplete,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between mb-1.5">
        <span className="text-sm font-medium text-ink/85">{label}</span>
        {hint && <span className="text-xs text-ink/50">{hint}</span>}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        required
        className="w-full h-11 rounded-xl bg-paper-cool border border-ink/15 px-4 text-[15px] focus:outline-none focus:ring-2 focus:ring-ink"
      />
    </label>
  );
}
