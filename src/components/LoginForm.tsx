"use client";

import { useState } from "react";
import { createAuthClient } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";

const auth = createAuthClient({ plugins: [magicLinkClient()] });

// `sent` is what to say once the link is on its way; the sign-in page knows
// whether that is by email or only to the server's log.
export function LoginForm({
  providers,
  next,
  sent,
}: {
  providers: ("github" | "google")[];
  next: string;
  sent: string;
}) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  return (
    <>
      {providers.length > 0 && (
        <>
          <div className="providers">
            {providers.map((provider, i) => (
              <button
                key={provider}
                type="button"
                className={i === 0 ? "button" : "button outline"}
                onClick={() => auth.signIn.social({ provider, callbackURL: next })}
              >
                Continue with {provider === "github" ? "GitHub" : "Google"}
              </button>
            ))}
          </div>
          <div className="or">or by email</div>
        </>
      )}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setState("sending");
          const email = String(new FormData(e.currentTarget).get("email"));
          const { error } = await auth.signIn.magicLink({ email, callbackURL: next });
          setState(error ? "failed" : "sent");
        }}
      >
        <label htmlFor="si-email">Email</label>
        <input id="si-email" type="email" name="email" required autoComplete="email" placeholder="you@company.com" />
        <button type="submit" className="button outline" disabled={state === "sending"}>
          Email me a link
        </button>
      </form>
      {state === "sent" && <p role="status">{sent}</p>}
      {state === "failed" && <p role="alert">That did not work. Try again in a minute.</p>}
    </>
  );
}
