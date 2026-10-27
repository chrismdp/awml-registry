import Link from "next/link";
import { edition } from "@/edition";
import { organisationsOf } from "@/server/organisations";
import { pageContext } from "@/server/page";
import { Logo } from "./Logo";
import { SiteNav } from "./SiteFrame";

const DOCS = "https://github.com/chrismdp/awml#readme";

// The site's header: the main links and who is signed in. The root layout
// shows it from its chrome slot (src/app/@chrome), on every page but an
// embed's (#75), so the root layout itself reads no session; an address no
// route answers shows it from src/app/global-not-found.tsx.
export async function SiteHeader() {
  const { db, viewer } = await pageContext();
  // Inventory goes to the viewer's first organisation, to making one, or to sign-in.
  const [org] = viewer ? await organisationsOf(db, viewer.id) : [];
  const inventory = org ? `/${org.slug}/inventory` : viewer ? "/settings" : "/login";
  return (
    <header className="site-header">
      <div className="left">
        <Logo />
        <SiteNav
          links={[
            // `/` is the gallery too, unless the edition gives a home page.
            { href: "/gallery", label: "Gallery", match: edition.homePage ? "^/gallery$" : "^/(gallery)?$" },
            { href: inventory, label: "Inventory", match: "/inventory$" },
            { href: DOCS, label: "Docs" },
          ]}
        />
      </div>
      {viewer ? (
        <Link href="/settings" className="account">
          <span>{viewer.username}</span>
          <span className="avatar" aria-label="Your account">
            {viewer.username.slice(0, 1).toUpperCase()}
          </span>
        </Link>
      ) : (
        <Link href="/login" className="button">
          Sign in
        </Link>
      )}
    </header>
  );
}

// An embed page's chrome (#75): none, so it shows no header, footer or
// navigation, and nothing reads the session for it.
export function NoChrome() {
  return null;
}
