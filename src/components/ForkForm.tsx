"use client";

import { useActionState } from "react";
import type { ForkState } from "@/app/[owner]/[slug]/actions";

// The header's Fork, which opens a small form under it: where the fork goes,
// out of the viewer and their organisations, its slug, the original's unless
// changed, and whether it is public. It forks the version shown, and a
// refusal is said in the form.
export function ForkForm({
  action,
  from,
  version,
  slug,
  owners,
}: {
  action: (state: ForkState, form: FormData) => Promise<ForkState>;
  from: string;
  version: number;
  slug: string;
  owners: string[];
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <details className="fork" open={state.error ? true : undefined}>
      <summary className="button outline">Fork</summary>
      <form className="fork-form" action={formAction}>
        <input type="hidden" name="from" value={from} />
        <input type="hidden" name="version" value={version} />
        <p className="after">
          Copy version {version} of {from} into an owner of yours, as its version 1.
        </p>
        <label className="field">
          Owner
          <select name="owner" defaultValue={owners[0]}>
            {owners.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Slug
          <input name="slug" defaultValue={slug} required />
        </label>
        <fieldset className="field">
          <legend>Who may see it</legend>
          <label>
            <input type="radio" name="visibility" value="public" defaultChecked /> Public
          </label>
          <label>
            <input type="radio" name="visibility" value="private" /> Private
          </label>
        </fieldset>
        {state.error && (
          <p role="alert" className="error">
            {state.error}
          </p>
        )}
        <button type="submit" className="button" disabled={pending}>
          Fork
        </button>
      </form>
    </details>
  );
}
