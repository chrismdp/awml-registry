"use client";

import { useActionState } from "react";
import type { MakeTokenState } from "@/app/settings/tokens/actions";
import { CopyButton } from "./CopyButton";

// A token just made, shown this once, above the form that made it.
export function NewToken({ name, secret }: { name: string; secret: string }) {
  return (
    <section className="settings-card dark" role="status">
      <h2>Your new token, &quot;{name}&quot;</h2>
      <p className="lead">Copy it now. We keep only a fingerprint, so this page can&apos;t show it again.</p>
      <div className="secret">
        <code id="new-token">{secret}</code>
        <CopyButton target="new-token" />
      </div>
      <p className="after">
        Then run <code>awml login</code> and paste it.
      </p>
    </section>
  );
}

export function MakeTokenForm({
  action,
}: {
  action: (state: MakeTokenState, form: FormData) => Promise<MakeTokenState>;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <>
      {state.secret && <NewToken name={state.name ?? ""} secret={state.secret} />}
      <section className="settings-card">
        <h2>Make a token</h2>
        <form className="fields-row" action={formAction}>
          <label className="field">
            What it&apos;s for
            <input name="name" placeholder="Work laptop" required />
          </label>
          <button type="submit" className="button" disabled={pending}>
            Make token
          </button>
        </form>
      </section>
    </>
  );
}
