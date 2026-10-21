import Link from "next/link";

export const metadata = { title: "Privacy · AWML Registry" };

export default function PrivacyPage() {
  return (
    <section className="plain-page">
      <h1>Privacy</h1>
      <p>
        The AWML Registry at awml.io is run by chrismdp Ltd, a company registered in England and Wales (number
        16198002). We decide what happens to the data described here. Questions go to{" "}
        <a href="mailto:chris@chrismdp.com">chris@chrismdp.com</a>.
      </p>

      <h2>What we keep</h2>
      <ul className="list">
        <li>Your account: email address, name, username and profile picture, from GitHub, Google or the email you sign in with.</li>
        <li>Your signed-in sessions: the IP address and browser they started from, so you stay signed in and we can spot misuse.</li>
        <li>The workflows you push, every version of each, and the organisations and members you set up.</li>
        <li>Access tokens you make, stored only as a one-way hash.</li>
        <li>An audit log for each organisation: who pushed, viewed a private workflow, joined or left, and when.</li>
      </ul>
      <p>
        We use one cookie, to keep you signed in. There is no advertising and no tracking. We never send your workflows
        to an AI model.
      </p>

      <h2>Why</h2>
      <p>
        We use this data to run the registry for you, which is the contract between us, and to keep it secure, which is
        our legitimate interest. We do not sell it or use it for marketing.
      </p>

      <h2>Where it lives</h2>
      <p>
        The database is held in the EU on Cloudflare. These companies handle data for us:
      </p>
      <ul className="list">
        <li>Cloudflare hosts the site and database and sends sign-in emails.</li>
        <li>GitHub or Google, only if you choose to sign in with them.</li>
        <li>Google Fonts serves the site&apos;s typefaces, so Google sees your IP address when a page loads.</li>
      </ul>

      <h2>Public and private</h2>
      <p>
        A public workflow can be read by anyone. A private workflow can be read only by members of its organisation.
      </p>

      <h2>How long</h2>
      <p>
        We keep your data while your account exists. Ask us to delete your account and we remove it and the workflows
        you own within 30 days.
      </p>

      <h2>Your rights</h2>
      <p>
        Under UK and EU data protection law you can ask to see, correct, export or delete your data, or object to how we
        use it. Email us and we will reply within a month. You can also complain to the Information Commissioner&apos;s
        Office at <a href="https://ico.org.uk">ico.org.uk</a>.
      </p>

      <p>
        Last updated 21 October 2026. See also the <Link href="/terms">terms</Link>.
      </p>
    </section>
  );
}
