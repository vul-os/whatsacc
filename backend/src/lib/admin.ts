// Instance-admin helpers: constant-time claim-token comparison and the
// admin-audit writer shared by the /admin routes and the admin gate.

import type { TxSql } from './db.ts';

/**
 * Constant-time string comparison for secret tokens.
 *
 * Both inputs are SHA-256 hashed first, so the byte-compare always runs over
 * equal-length (32-byte) buffers regardless of input lengths — neither the
 * length nor the position of the first differing byte of the secret leaks
 * through timing.
 */
export async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const ua = new Uint8Array(da);
  const ub = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) {
    diff |= ua[i]! ^ ub[i]!;
  }
  return diff === 0;
}

export type AdminAuditEntry = {
  actor_user_id: string | null;
  action: string;
  target_kind?: string | null;
  target_id?: string | null;
  allowed: boolean;
  detail?: Record<string, unknown>;
};

/**
 * Append an admin-audit row via the SECURITY DEFINER writer (the table has
 * no INSERT policy). Best-effort variants belong to the caller — this one
 * throws on failure so mutations and their audit rows commit atomically when
 * called inside the same transaction.
 */
export async function writeAdminAudit(tx: TxSql, entry: AdminAuditEntry): Promise<void> {
  await tx`
    select app.admin_audit_write(
      ${entry.actor_user_id}::uuid,
      ${entry.action},
      ${entry.target_kind ?? null},
      ${entry.target_id ?? null},
      ${entry.allowed},
      ${tx.json(entry.detail ?? {})}::jsonb
    )
  `;
}
