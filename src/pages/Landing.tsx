import { TopNav } from '@/components/nav/TopNav';
import { Hero } from '@/components/landing/Hero';
import { TryNow } from '@/components/landing/TryNow';
import { WhatsAppDemo } from '@/components/landing/WhatsAppDemo';
import { HowItWorks } from '@/components/landing/HowItWorks';
import { BuiltFor } from '@/components/landing/BuiltFor';
import { Features } from '@/components/landing/Features';
import { PeekInside } from '@/components/landing/PeekInside';
import { Pricing } from '@/components/landing/Pricing';
import { FAQ } from '@/components/landing/FAQ';
import { Footer } from '@/components/landing/Footer';

export default function Landing() {
  return (
    <div className="bg-paper">
      <TopNav />
      <Hero />
      <TryNow />
      <WhatsAppDemo />
      <HowItWorks />
      <BuiltFor />
      <Features />
      <PeekInside />
      <Pricing />
      <FAQ />
      <Footer />
    </div>
  );
}
