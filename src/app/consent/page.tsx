import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { ConsentForm } from "@/components/ConsentForm";
import { Logo } from "@/components/Logo";
import { getAuth } from "@/server/auth";
import { queryString, type Search } from "@/server/oauth";
import { pageContext } from "@/server/page";

// Where an AI client's sign-in asks the person to let it act as them on /mcp.
export default async function ConsentPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const query = queryString(search);
  const { viewer } = await pageContext();
  if (!viewer) redirect(`/login?${query}`);
  const auth = await getAuth();
  if (!(await verifyOAuthQueryParams(query, (await auth.$context).secret))) notFound();
  const clientId = String(search.client_id);
  const client = await auth.api
    .getOAuthClientPublic({ query: { client_id: clientId }, headers: await headers() })
    .catch(() => null);
  if (!client) notFound();
  const name = client.client_name || "An AI app";
  const back = new URL(String(search.redirect_uri)).host;
  return (
    <div className="signin-page">
      <Logo />
      <main className="signin">
        <h1>Let {name} use your account?</h1>
        <p className="lead">
          It will read the workflows you can see, private ones included, and publish new versions as {viewer.username}.
          It cannot change your account or your organisations.
        </p>
        <ConsentForm />
        <p className="small">After you choose, you go back to {back}.</p>
      </main>
    </div>
  );
}
