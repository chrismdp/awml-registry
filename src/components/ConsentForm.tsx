"use client";

import { useState } from "react";

// Allow or cancel an AI client's request, then go where the provider says:
// back to the client with a code, or with a refusal.
export function ConsentForm() {
  const [state, setState] = useState<"idle" | "sending" | "failed">("idle");
  async function decide(accept: boolean) {
    setState("sending");
    const res = await fetch("/api/auth/oauth2/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accept, oauth_query: window.location.search.slice(1) }),
    });
    const body = (await res.json().catch(() => null)) as { url?: string } | null;
    if (res.ok && body?.url) window.location.assign(body.url);
    else setState("failed");
  }
  return (
    <>
      <div className="providers">
        <button type="button" className="button" disabled={state === "sending"} onClick={() => decide(true)}>
          Allow
        </button>
        <button type="button" className="button outline" disabled={state === "sending"} onClick={() => decide(false)}>
          Cancel
        </button>
      </div>
      {state === "failed" && <p role="alert">That did not work. Go back to your AI app and connect again.</p>}
    </>
  );
}
