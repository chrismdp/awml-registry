import Link from "next/link";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/LoginForm";
import { edition } from "@/edition";
import { Logo } from "@/components/Logo";
import { socialProviderNames } from "@/server/auth";
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
  return (
    <div className="signin-page">
      <Logo />
      <main className="signin">
        <h1>Sign in</h1>
        <p className="lead">New here? This makes your account too.</p>
        <LoginForm providers={socialProviderNames()} next={target} />
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
