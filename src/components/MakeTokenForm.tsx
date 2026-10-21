"use client";

import { useActionState } from "react";
import type { MakeTokenState } from "@/app/settings/tokens/actions";

export function MakeTokenForm({
  action,
}: {
  action: (state: MakeTokenState, form: FormData) => Promise<MakeTokenState>;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <>
      <form action={formAction}>
        <label>
          Name <input name="name" placeholder="laptop" required />
        </label>{" "}
        <button type="submit" disabled={pending}>
          Make a token
        </button>
      </form>
      {state.secret && (
        <div role="status">
          <p>
            Your new token <strong>{state.name}</strong>. Copy it now: it will not be shown again.
          </p>
          <pre>
            <code>{state.secret}</code>
          </pre>
          <p>
            Then run <code>awml login</code> and paste it.
          </p>
        </div>
      )}
    </>
  );
}
