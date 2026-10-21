import { redirect } from "next/navigation";
import { LoginForm } from "@/components/LoginForm";
import { Logo } from "@/components/Logo";
import { socialProviderNames } from "@/server/auth";
import { pageContext } from "@/server/page";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const target = next?.startsWith("/") && !next.startsWith("//") ? next : "/settings";
  const { viewer } = await pageContext();
  if (viewer) redirect(target);
  return (
    <div className="signin-page">
      <Logo />
      <main className="signin">
        <h1>Sign in</h1>
        <p className="lead">New here? This makes your account too.</p>
        <LoginForm providers={socialProviderNames()} next={target} />
        <p className="small">The link works once, for 15 minutes. No passwords.</p>
      </main>
      <p className="foot">We never send your workflows to a model.</p>
    </div>
  );
}
