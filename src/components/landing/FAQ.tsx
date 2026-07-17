import { Accordion } from '@/components/ui/Accordion';

const items = [
  {
    q: 'Do residents need to install anything?',
    a: 'No. Residents text the whatsacc number from WhatsApp like they would any contact. The only people who install something are the property owner or manager — and that\'s the controller hardware that talks to the gate.',
  },
  {
    q: 'What happens if WhatsApp is down or my phone has no signal?',
    a: 'Most controllers can fall back to a local PIN keypad or a physical override. whatsacc isn\'t the only way in — it\'s the fastest, most pleasant way in. We also queue commands for up to 30 seconds across brief network blips.',
  },
  {
    q: 'How does the geofence work?',
    a: 'It\'s optional, per-location. When enabled, whatsacc asks WhatsApp for the sender\'s shared location at open time, or asks them to share live location. Open requests outside your radius are automatically denied and logged.',
  },
  {
    q: 'Can I revoke access for someone in seconds?',
    a: 'Yes. Open the member, hit revoke. It\'s effective on the next message. You can also schedule access (a contractor for one Saturday, a guest for the weekend) and it expires on its own.',
  },
  {
    q: 'What hardware does it work with?',
    a: 'Any gate or barrier with a dry-contact relay input — which is most of them. Our ACC controller plugs into the existing wiring next to your motor. We also have software-only integrations for Centurion, Came, BFT and Nice systems.',
  },
  {
    q: 'Is this secure enough for a complex with 200 residents?',
    a: 'Phone-number identity, signed device commands, optional geofence, full audit log, time-of-day and per-member rules. We treat every open as a request that has to earn its way through. See the security page for specifics.',
  },
];

export function FAQ() {
  return (
    <section className="relative">
      <div className="mx-auto max-w-[1280px] px-5 sm:px-6 lg:px-10 pt-2 md:pt-4 pb-20 md:pb-24 lg:pb-32">
        <div className="grid grid-cols-12 sm:gap-x-8 gap-y-6 mb-10 md:mb-12">
          <div className="col-span-12 lg:col-span-6">
            <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-ink/55">
              <span className="h-1 w-1 rounded-full bg-terracotta" aria-hidden />
              Common questions
            </span>
            <h2 className="mt-4 font-display-tight text-4xl sm:text-5xl lg:text-[56px] leading-[0.96] tracking-[-0.02em]">
              The things <em className="italic">people ask first.</em>
            </h2>
          </div>
        </div>

        <Accordion items={items} />
      </div>
    </section>
  );
}
