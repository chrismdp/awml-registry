import Link from "next/link";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/LoginForm";
import { edition } from "@/edition";
import { Logo } from "@/components/Logo";
import { socialProviderNames } from "@/server/auth";
import { signInLinksEmailed } from "@/server/email";
import { authorizeAgain, type Search } from "@/server/oauth";
import { pageContext } from "@/server/page";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const next = typeof search.next === "string" ? search.next : undefined;
  // An AI client signing in to /mcp sends the person here first; after
  // signing in they go back to finish allowing it.
  const target = authorizeAgain(search) ?? (next?.startsWith("/") && !next.startsWith("//") ? next : "/settings");
  const { viewer } = await pageContext();
  if (viewer) redirect(target);
  const legal = edition.legalLinks;
  const sent = (await signInLinksEmailed())
    ? "Check your email for a link to sign in."
    : "This registry has no email set up, so the link was printed to the server's log instead of sent.";
  return (
    <div className="signin-page">
      <Logo />
      <main className="signin">
        <h1>Sign in</h1>
        <p className="lead">New here? This makes your account too.</p>
        <LoginForm providers={socialProviderNames()} next={target} sent={sent} />
        <p className="small">The link works once, for 15 minutes. No passwords.</p>
      </main>
      <p className="foot">
        {legal && (
          <>
            By signing in you agree to the <Link href={legal.terms}>terms</Link> and{" "}
            <Link href={legal.privacy}>privacy policy</Link>.{" "}
          </>
        )}
        We never send your workflows to a model.
      </p>
    </div>
  );
}
