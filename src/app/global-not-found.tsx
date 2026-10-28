import { SiteHeader } from "@/components/SiteHeader";
import RootLayout from "./layout";
import NotFound from "./not-found";

export { metadata } from "./layout";

// The 404 for an address no route answers. Next renders it on its own, with
// no layout, so it is the root layout's page given the site's header itself:
// the root layout takes its header only from the chrome slot (#75), which an
// address no route answers doesn't have.
export default function GlobalNotFound() {
  return (
    <RootLayout chrome={<SiteHeader />}>
      <NotFound />
    </RootLayout>
  );
}
