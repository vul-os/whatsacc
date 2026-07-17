import type { TxSql } from './db.ts';

export type AvailableAP = {
  ap_id: string;
  ap_name: string;
  loc_id: string;
  loc_name: string;
  type: 'member' | 'visitor';
  grant_id?: string;
  max_uses?: number | null;
  uses_count?: number;
};

/**
 * Finds all access points a user has access to, either via a verified phone
 * number (WhatsApp/Visitor/Member) or directly via a profile ID (Slack/Member).
 */
export async function getAvailableAccessPoints(
  tx: TxSql,
  params: { phoneE164?: string; profileId?: string },
): Promise<AvailableAP[]> {
  const { phoneE164, profileId } = params;
  const results: AvailableAP[] = [];

  if (phoneE164) {
    // 1. Visitor grants by phone
    const visitorGrants = await tx<
      {
        id: string;
        max_uses: number | null;
        uses_count: number;
        ap_id: string;
        ap_name: string;
        loc_id: string;
        loc_name: string;
      }[]
    >`
      select g.id, g.max_uses, g.uses_count,
             ap.id as ap_id, ap.name as ap_name,
             l.id as loc_id, l.name as loc_name
      from temporary_access_grants g
      join temporary_access_grant_access_points t on t.grant_id = g.id
      join access_points ap on ap.id = t.access_point_id
      join locations l on l.id = ap.location_id
      where g.phone_e164 = ${phoneE164}
        and g.status = 'active'
        and g.starts_at <= now()
        and g.ends_at > now()
        and (g.max_uses is null or g.uses_count < g.max_uses)
        and ap.status = 'active'
      order by g.ends_at asc
    `;
    for (const g of visitorGrants) {
      results.push({
        ap_id: g.ap_id,
        ap_name: g.ap_name,
        loc_id: g.loc_id,
        loc_name: g.loc_name,
        type: 'visitor',
        grant_id: g.id,
        max_uses: g.max_uses,
        uses_count: g.uses_count,
      });
    }

    // 2. Member access by phone
    const memberGrants = await tx<
      {
        ap_id: string;
        ap_name: string;
        loc_id: string;
        loc_name: string;
      }[]
    >`
      select ap.id as ap_id, ap.name as ap_name, l.id as loc_id, l.name as loc_name
      from profile_phone_numbers ppn
      join profiles p on p.id = ppn.profile_id
      join users u on u.id = p.id
      join account_members am on am.user_id = p.id
      join locations l on l.account_id = am.account_id
      join access_points ap on ap.location_id = l.id
      where ppn.phone_e164 = ${phoneE164}
        and ppn.verified_at is not null
        and u.status = 'active'  -- disabled users lose chat-resolved access
        and am.status = 'active'
        and ap.status = 'active'
    `;
    for (const g of memberGrants) {
      // Avoid duplicates if a user has both a grant and member access
      if (!results.some(r => r.ap_id === g.ap_id)) {
        results.push({
          ap_id: g.ap_id,
          ap_name: g.ap_name,
          loc_id: g.loc_id,
          loc_name: g.loc_name,
          type: 'member',
        });
      }
    }
  }

  if (profileId) {
    // 3. Member access by profile ID (e.g. for Slack)
    const memberGrants = await tx<
      {
        ap_id: string;
        ap_name: string;
        loc_id: string;
        loc_name: string;
      }[]
    >`
      select ap.id as ap_id, ap.name as ap_name, l.id as loc_id, l.name as loc_name
      from profiles p
      join users u on u.id = p.id
      join account_members am on am.user_id = p.id
      join locations l on l.account_id = am.account_id
      join access_points ap on ap.location_id = l.id
      where p.id = ${profileId}
        and u.status = 'active'  -- disabled users lose chat-resolved access
        and am.status = 'active'
        and ap.status = 'active'
    `;
    for (const g of memberGrants) {
      if (!results.some(r => r.ap_id === g.ap_id)) {
        results.push({
          ap_id: g.ap_id,
          ap_name: g.ap_name,
          loc_id: g.loc_id,
          loc_name: g.loc_name,
          type: 'member',
        });
      }
    }
  }

  return results;
}
