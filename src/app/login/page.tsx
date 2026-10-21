import { redirect } from "next/navigation";
import { LoginForm } from "@/components/LoginForm";
import { socialProviderNames } from "@/server/auth";
import { pageContext } from "@/server/page";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const target = next?.startsWith("/") && !next.startsWith("//") ? next : "/settings";
  const { viewer } = await pageContext();
  if (viewer) redirect(target);
  return (
    <section>
      <h1>Sign in</h1>
      <LoginForm providers={socialProviderNames()} next={target} />
    </section>
  );
}
