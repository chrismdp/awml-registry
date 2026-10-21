"use client";

import { useState } from "react";
import { createAuthClient } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";

const auth = createAuthClient({ plugins: [magicLinkClient()] });

export function LoginForm({ providers, next }: { providers: ("github" | "google")[]; next: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  return (
    <>
      {providers.map((provider) => (
        <p key={provider}>
          <button type="button" onClick={() => auth.signIn.social({ provider, callbackURL: next })}>
            Sign in with {provider === "github" ? "GitHub" : "Google"}
          </button>
        </p>
      ))}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setState("sending");
          const email = String(new FormData(e.currentTarget).get("email"));
          const { error } = await auth.signIn.magicLink({ email, callbackURL: next });
          setState(error ? "failed" : "sent");
        }}
      >
        <label>
          Email <input type="email" name="email" required autoComplete="email" />
        </label>{" "}
        <button type="submit" disabled={state === "sending"}>
          Email me a sign-in link
        </button>
      </form>
      {state === "sent" && <p role="status">Check your email for a link to sign in.</p>}
      {state === "failed" && <p role="alert">That did not work. Try again in a minute.</p>}
    </>
  );
}
