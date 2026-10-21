import Link from "next/link";

export const metadata = { title: "Terms · AWML Registry" };

export default function TermsPage() {
  return (
    <section className="plain-page">
      <h1>Terms</h1>
      <p>
        These terms cover your use of the AWML Registry at awml.io, run by chrismdp Ltd, a company registered in England
        and Wales (number 16198002). By signing in you agree to them.
      </p>

      <h2>Your workflows</h2>
      <p>
        You own what you push. You let us store, copy and show it so the registry works: to everyone if it is public,
        and to your organisation&apos;s members if it is private. Only push what you have the right to share.
      </p>

      <h2>Fair use</h2>
      <p>
        Do not push anything unlawful, put secrets or other people&apos;s personal data into public workflows, or try to
        break into or overload the service. We may remove content or close accounts that do.
      </p>

      <h2>The service</h2>
      <p>
        The registry is free while it is in early use. We provide it as it is, and it may change or have outages. We are
        not liable for indirect losses, or for more than you have paid us in the last twelve months, except where the
        law does not allow us to limit liability.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms and will say so on this page. English law applies, and the courts of England and
        Wales decide any dispute.
      </p>

      <p>
        Last updated 21 October 2026. Questions go to <a href="mailto:chris@chrismdp.com">chris@chrismdp.com</a>. See
        also the <Link href="/privacy">privacy policy</Link>.
      </p>
    </section>
  );
}
