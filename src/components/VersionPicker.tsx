"use client";

import { useId, useRef, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";

type Target = { closest(selector: string): unknown } | null;

// Whether a click in the Versions dialog closes it: one on its backdrop, which
// lands on the dialog itself since its box fills it, or one on a link, which
// goes to another version or person.
export const closesOn = (target: Target, dialog: Target) => target != null && (target === dialog || target.closest("a") != null);

const Chevron = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
    <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// The header's "Version n of m" as a button that opens the versions, listed
// in `children`, in a native dialog: Esc and focus are the browser's, a click
// on the backdrop or the Close button closes it, and a long list scrolls
// inside it.
export function VersionsDialog({ number, latest, children }: { number: number; latest: number; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const onClick = (e: MouseEvent<HTMLDialogElement>) => {
    if (closesOn(e.target as Element, e.currentTarget)) e.currentTarget.close();
  };
  return (
    <>
      <button type="button" className="version-pick" aria-haspopup="dialog" onClick={() => dialog.current?.showModal()}>
        Version {number} of {latest}
        <Chevron />
      </button>
      <dialog ref={dialog} className="versions-dialog" aria-labelledby={title} onClick={onClick}>
        <div className="versions-dialog-box">
          <div className="versions-dialog-head">
            <h2 id={title}>Versions</h2>
            <button type="button" className="button" onClick={() => dialog.current?.close()}>
              Close
            </button>
          </div>
          <div className="versions-dialog-list">{children}</div>
        </div>
      </dialog>
    </>
  );
}

const noChange = () => () => {};

// The header's "Version n of m" with the versions behind it. As the server
// sends it, and so without JavaScript, it is a <details> that opens the list
// under it; once the page's script runs, it is the button and dialog above.
export function VersionPicker({ number, latest, children }: { number: number; latest: number; children: ReactNode }) {
  const scripted = useSyncExternalStore(
    noChange,
    () => true,
    () => false,
  );
  if (scripted)
    return (
      <VersionsDialog number={number} latest={latest}>
        {children}
      </VersionsDialog>
    );
  return (
    <details className="version-pick">
      <summary>
        Version {number} of {latest}
        <Chevron />
      </summary>
      <div className="version-pick-list">{children}</div>
    </details>
  );
}
