// Shared invoice issuance + PDF rendering.
//
// Both the wallet-topup credit path (routes/billing.ts) and the subscription
// renewal cron (lib/subscriptions.ts) issue invoices through the same helper
// so VAT/issuer snapshots stay consistent and idempotency keys are uniform.

import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';
import type { JSONValue, TxSql } from './db.ts';
import { getEnv } from './env.ts';

export type InvoiceLineItem = {
  description: string;
  quantity: number;
  unit_cents: number;
  line_cents: number;
};

export type InvoiceBillTo = {
  account_name: string;
  billing_address: unknown;
  country_code: string | null;
};

export type InvoiceIssuer = {
  name: string;
  registration: string | null;
  vat_number: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
};

export type InvoiceRow = {
  id: string;
  account_id: string;
  number: string;
  kind: string;
  payment_intent_id: string | null;
  currency: string;
  subtotal_cents: string | number;
  vat_rate_bps: number;
  vat_cents: string | number;
  total_cents: string | number;
  bill_to: unknown;
  issuer: unknown;
  line_items: unknown;
  status: string;
  issued_at: Date;
  paid_at: Date | null;
};

export function invoiceIssuerSnapshot(): InvoiceIssuer {
  const env = getEnv();
  return {
    name: env.COMPANY_NAME ?? 'whatsacc',
    registration: env.COMPANY_REGISTRATION ?? null,
    vat_number: env.COMPANY_VAT_NUMBER ?? null,
    address: env.COMPANY_ADDRESS ?? null,
    email: env.COMPANY_EMAIL ?? null,
    phone: env.COMPANY_PHONE ?? null,
  };
}

/**
 * Compute the VAT split for an inclusive total. If COMPANY_VAT_NUMBER is unset,
 * VAT is zero and the total flows entirely to subtotal — invoices remain
 * legally valid for a non-VAT-registered seller.
 */
export function vatBreakdown(totalCents: number): {
  subtotal_cents: number;
  vat_rate_bps: number;
  vat_cents: number;
} {
  const env = getEnv();
  const vatRateBps = env.COMPANY_VAT_NUMBER
    ? Math.max(0, Math.min(10_000, env.VAT_RATE_BPS ?? 1500))
    : 0;
  if (vatRateBps === 0) {
    return { subtotal_cents: totalCents, vat_rate_bps: 0, vat_cents: 0 };
  }
  const subtotal = Math.round((totalCents * 10_000) / (10_000 + vatRateBps));
  return {
    subtotal_cents: subtotal,
    vat_rate_bps: vatRateBps,
    vat_cents: totalCents - subtotal,
  };
}

export type CreateInvoiceArgs = {
  tx: TxSql;
  account_id: string;
  kind: 'wallet_topup' | 'subscription' | 'manual' | 'refund';
  /**
   * Stable idempotency key. Either:
   *   - payment_intent_id: stored as FK on invoices.payment_intent_id
   *   - external_ref: an arbitrary string (e.g. 'subscription_renewal:<id>')
   * Exactly one must be provided.
   */
  payment_intent_id?: string | null;
  external_ref?: string | null;
  total_cents: number;
  currency: string;
  line_items: InvoiceLineItem[];
  status?: 'paid' | 'issued' | 'void';
  paid_at?: Date | null;
};

/**
 * Insert an invoice row idempotently. Re-running for the same idempotency key
 * (payment_intent_id OR external_ref) returns the existing invoice id rather
 * than creating a duplicate.
 */
export async function createInvoice(args: CreateInvoiceArgs): Promise<string> {
  const { tx } = args;
  if (!args.payment_intent_id && !args.external_ref) {
    throw new Error('createInvoice: payment_intent_id or external_ref required');
  }

  // Idempotency check.
  if (args.payment_intent_id) {
    const existing = await tx<{ id: string }[]>`
      select id from invoices where payment_intent_id = ${args.payment_intent_id} limit 1
    `;
    if (existing[0]) return existing[0].id;
  } else if (args.external_ref) {
    const existing = await tx<{ id: string }[]>`
      select id from invoices where external_ref = ${args.external_ref} limit 1
    `;
    if (existing[0]) return existing[0].id;
  }

  const accountRows = await tx<{
    name: string;
    billing_address: unknown;
    country_code: string | null;
  }[]>`
    select name, billing_address, country_code
    from accounts
    where id = ${args.account_id}
  `;
  const account = accountRows[0];

  const vat = vatBreakdown(args.total_cents);
  // Re-derive subtotals across line items proportionally if VAT is on. The
  // caller passes ex-VAT line totals when VAT is off, or inclusive amounts
  // when caller doesn't care about per-line splits.
  const scaledLines: InvoiceLineItem[] =
    vat.vat_rate_bps === 0
      ? args.line_items
      : args.line_items.map((li) => ({
          ...li,
          unit_cents: Math.round((li.unit_cents * vat.subtotal_cents) / args.total_cents),
          line_cents: Math.round((li.line_cents * vat.subtotal_cents) / args.total_cents),
        }));

  const billTo: InvoiceBillTo = {
    account_name: account?.name ?? 'Customer',
    billing_address: account?.billing_address ?? {},
    country_code: account?.country_code ?? null,
  };

  const [invoice] = await tx<{ id: string }[]>`
    insert into invoices
      (account_id, number, kind, payment_intent_id, external_ref, currency,
       subtotal_cents, vat_rate_bps, vat_cents, total_cents,
       bill_to, issuer, line_items, status, paid_at)
    values
      (
        ${args.account_id},
        '',
        ${args.kind},
        ${args.payment_intent_id ?? null},
        ${args.external_ref ?? null},
        ${args.currency},
        ${vat.subtotal_cents},
        ${vat.vat_rate_bps},
        ${vat.vat_cents},
        ${args.total_cents},
        ${tx.json(billTo as unknown as JSONValue)},
        ${tx.json(invoiceIssuerSnapshot() as unknown as JSONValue)},
        ${tx.json(scaledLines as unknown as JSONValue)},
        ${args.status ?? 'paid'},
        ${args.paid_at ?? (args.status === 'issued' ? null : new Date())}
      )
    returning id
  `;
  return invoice!.id;
}

// ─────────────────────────────────────────────────────────────────────────
// PDF rendering — styled, pdf-lib backed, with the whatsacc tunnel-arch mark
// drawn directly from primitives (no external image asset to bundle).
// ─────────────────────────────────────────────────────────────────────────

const INK = rgb(0x1a / 0xff, 0x1f / 0xff, 0x36 / 0xff);          // navy
const TERRACOTTA = rgb(0xd6 / 0xff, 0x62 / 0xff, 0x4d / 0xff);    // accent
const PAPER = rgb(0xf4 / 0xff, 0xed / 0xff, 0xe2 / 0xff);         // canvas
const INK_60 = rgb(0x55 / 0xff, 0x5b / 0xff, 0x6c / 0xff);        // body
const RULE = rgb(0xe6 / 0xff, 0xe1 / 0xff, 0xd5 / 0xff);          // hairline

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function money(cents: string | number, currency: string): string {
  const n = Number(cents) / 100;
  return `${currency} ${n.toFixed(2)}`;
}

function drawLogo(page: PDFPage, x: number, y: number, size: number): void {
  // Reproduce the icon.svg mark (tunnel arch + keystone) from pdf-lib
  // primitives — no image asset to bundle. Source viewBox is 64×64, so we
  // scale by `size/64` and translate to (x, y) where (x, y) is the top-left
  // corner of the badge in PDF user space.
  const s = size / 64;
  // Body: ink-navy square. pdf-lib's drawRectangle has no border-radius, so
  // this is a hard-cornered version of the SVG's rx=13 rounded rect — at the
  // logo size we use (56pt) the corner crop is unnoticeable on print.
  page.drawRectangle({
    x,
    y: y - size,
    width: size,
    height: size,
    color: INK,
  });
  // Arch: SVG path "M14 50 V32 a18 18 0 0 1 36 0 V50 H40 V32 a8 8 0 0 0 -16 0 V50 Z".
  // drawSvgPath treats the supplied (x, y) as the SVG origin; SVG +y is down,
  // which matches what we want when y is the top of the badge.
  page.drawSvgPath(
    'M14 50 V32 a18 18 0 0 1 36 0 V50 H40 V32 a8 8 0 0 0 -16 0 V50 Z',
    {
      x,
      y,
      scale: s,
      borderColor: PAPER,
      borderWidth: 3.2 * s,
    },
  );
  // Keystone dot at SVG (32, 42).
  page.drawCircle({
    x: x + 32 * s,
    y: y - 42 * s,
    size: 3 * s,
    color: TERRACOTTA,
  });
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    const words = para.split(/\s+/);
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out;
}

export async function buildInvoicePdf(row: InvoiceRow): Promise<Uint8Array> {
  const issuer = asRecord(row.issuer);
  const billTo = asRecord(row.bill_to);
  const linesRaw = Array.isArray(row.line_items) ? row.line_items : [];

  const doc = await PDFDocument.create();
  doc.setTitle(`Invoice ${row.number}`);
  doc.setAuthor(String(issuer.name ?? 'whatsacc'));
  doc.setCreator('whatsacc');

  const page = doc.addPage([595.28, 841.89]); // A4 portrait
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const { width, height } = page.getSize();
  const margin = 48;

  // — Header band ————————————————————————————————————————————————
  drawLogo(page, margin, height - margin, 56);

  page.drawText('INVOICE', {
    x: width - margin - helvBold.widthOfTextAtSize('INVOICE', 28),
    y: height - margin - 22,
    size: 28,
    font: helvBold,
    color: INK,
  });
  page.drawText(row.number, {
    x: width - margin - helv.widthOfTextAtSize(row.number, 11),
    y: height - margin - 40,
    size: 11,
    font: helv,
    color: INK_60,
  });

  // — Issuer ↔ Bill-to ——————————————————————————————————————————————
  const blockTop = height - margin - 90;
  const colGap = 24;
  const colWidth = (width - margin * 2 - colGap) / 2;

  const issuerLines: string[] = [
    String(issuer.name ?? 'whatsacc'),
    issuer.registration ? `Reg: ${String(issuer.registration)}` : '',
    issuer.vat_number ? `VAT: ${String(issuer.vat_number)}` : '',
    issuer.address ? String(issuer.address) : '',
    issuer.email ? String(issuer.email) : '',
    issuer.phone ? String(issuer.phone) : '',
  ].filter(Boolean);

  const billLines: string[] = [
    String(billTo.account_name ?? 'Customer'),
    billTo.country_code ? String(billTo.country_code) : '',
  ].filter(Boolean);

  drawLabel(page, helvBold, 'From', margin, blockTop);
  drawTextBlock(page, helv, issuerLines, margin, blockTop - 14, colWidth, INK);

  drawLabel(page, helvBold, 'Bill to', margin + colWidth + colGap, blockTop);
  drawTextBlock(page, helv, billLines, margin + colWidth + colGap, blockTop - 14, colWidth, INK);

  // — Metadata row ——————————————————————————————————————————————————
  const metaTop = blockTop - 14 - Math.max(issuerLines.length, billLines.length) * 13 - 28;

  const metaY = metaTop;
  drawLabel(page, helvBold, 'Issued', margin, metaY);
  page.drawText(row.issued_at.toISOString().slice(0, 10), {
    x: margin,
    y: metaY - 14,
    size: 11,
    font: helv,
    color: INK,
  });
  drawLabel(page, helvBold, 'Status', margin + 140, metaY);
  page.drawText(row.status.toUpperCase(), {
    x: margin + 140,
    y: metaY - 14,
    size: 11,
    font: helvBold,
    color: row.status === 'paid' ? rgb(0.16, 0.45, 0.27) : INK,
  });
  drawLabel(page, helvBold, 'Currency', margin + 280, metaY);
  page.drawText(row.currency, {
    x: margin + 280,
    y: metaY - 14,
    size: 11,
    font: helv,
    color: INK,
  });

  // — Items table ——————————————————————————————————————————————————
  const tableTop = metaY - 42;
  const descX = margin;
  const qtyX = margin + 320;
  const unitX = margin + 380;
  const lineX = width - margin;

  page.drawLine({
    start: { x: margin, y: tableTop + 4 },
    end: { x: width - margin, y: tableTop + 4 },
    thickness: 0.5,
    color: RULE,
  });
  page.drawText('Description', {
    x: descX,
    y: tableTop - 12,
    size: 9,
    font: helvBold,
    color: INK_60,
  });
  page.drawText('Qty', {
    x: qtyX,
    y: tableTop - 12,
    size: 9,
    font: helvBold,
    color: INK_60,
  });
  page.drawText('Unit', {
    x: unitX,
    y: tableTop - 12,
    size: 9,
    font: helvBold,
    color: INK_60,
  });
  const totalLabel = 'Total';
  page.drawText(totalLabel, {
    x: lineX - helvBold.widthOfTextAtSize(totalLabel, 9),
    y: tableTop - 12,
    size: 9,
    font: helvBold,
    color: INK_60,
  });
  page.drawLine({
    start: { x: margin, y: tableTop - 18 },
    end: { x: width - margin, y: tableTop - 18 },
    thickness: 0.5,
    color: RULE,
  });

  let rowY = tableTop - 36;
  for (const raw of linesRaw) {
    const item = asRecord(raw);
    const desc = String(item.description ?? 'Item');
    const wrapped = wrap(desc, helv, 11, qtyX - descX - 8);
    for (const [i, ln] of wrapped.entries()) {
      page.drawText(ln, { x: descX, y: rowY - i * 13, size: 11, font: helv, color: INK });
    }
    page.drawText(String(item.quantity ?? 1), {
      x: qtyX,
      y: rowY,
      size: 11,
      font: helv,
      color: INK,
    });
    page.drawText(money(Number(item.unit_cents ?? 0), row.currency), {
      x: unitX,
      y: rowY,
      size: 11,
      font: helv,
      color: INK,
    });
    const lineAmt = money(Number(item.line_cents ?? 0), row.currency);
    page.drawText(lineAmt, {
      x: lineX - helv.widthOfTextAtSize(lineAmt, 11),
      y: rowY,
      size: 11,
      font: helv,
      color: INK,
    });
    rowY -= 18 + (wrapped.length - 1) * 13;
  }

  // — Totals block ——————————————————————————————————————————————————
  const totalsTop = rowY - 14;
  page.drawLine({
    start: { x: margin + 280, y: totalsTop + 4 },
    end: { x: width - margin, y: totalsTop + 4 },
    thickness: 0.5,
    color: RULE,
  });
  drawTotalRow(page, helv, helv, 'Subtotal', money(row.subtotal_cents, row.currency), totalsTop - 6, margin, width);
  drawTotalRow(
    page,
    helv,
    helv,
    `VAT (${(row.vat_rate_bps / 100).toFixed(2)}%)`,
    money(row.vat_cents, row.currency),
    totalsTop - 24,
    margin,
    width,
  );
  page.drawLine({
    start: { x: margin + 280, y: totalsTop - 32 },
    end: { x: width - margin, y: totalsTop - 32 },
    thickness: 0.5,
    color: RULE,
  });
  drawTotalRow(
    page,
    helvBold,
    helvBold,
    'Total',
    money(row.total_cents, row.currency),
    totalsTop - 46,
    margin,
    width,
  );

  // — Footer ————————————————————————————————————————————————————————
  const footY = 56;
  page.drawLine({
    start: { x: margin, y: footY + 16 },
    end: { x: width - margin, y: footY + 16 },
    thickness: 0.5,
    color: RULE,
  });
  const footerText = issuer.vat_number
    ? `Thank you. Issued by ${String(issuer.name ?? 'whatsacc')} · VAT ${String(issuer.vat_number)}.`
    : `Thank you. Issued by ${String(issuer.name ?? 'whatsacc')}.`;
  page.drawText(footerText, {
    x: margin,
    y: footY,
    size: 9,
    font: helv,
    color: INK_60,
  });

  return await doc.save();
}

function drawLabel(page: PDFPage, font: PDFFont, text: string, x: number, y: number): void {
  page.drawText(text.toUpperCase(), {
    x,
    y,
    size: 8,
    font,
    color: INK_60,
  });
}

function drawTextBlock(
  page: PDFPage,
  font: PDFFont,
  lines: string[],
  x: number,
  y: number,
  maxWidth: number,
  color = INK,
): void {
  let cursor = y;
  for (const line of lines) {
    const wrapped = wrap(line, font, 11, maxWidth);
    for (const w of wrapped) {
      page.drawText(w, { x, y: cursor, size: 11, font, color });
      cursor -= 13;
    }
  }
}

function drawTotalRow(
  page: PDFPage,
  labelFont: PDFFont,
  valueFont: PDFFont,
  label: string,
  value: string,
  y: number,
  margin: number,
  width: number,
): void {
  page.drawText(label, { x: margin + 280, y, size: 11, font: labelFont, color: INK });
  page.drawText(value, {
    x: width - margin - valueFont.widthOfTextAtSize(value, 11),
    y,
    size: 11,
    font: valueFont,
    color: INK,
  });
}
