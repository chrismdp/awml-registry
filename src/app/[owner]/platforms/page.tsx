import Link from "next/link";
import { notFound } from "next/navigation";
import { OrgTabs } from "@/components/OrgTabs";
import { AddPlatform, PlatformList, ShortHelp, WhatAPlatformIs } from "@/components/Platforms";
import { pageContext } from "@/server/page";
import { ownerPlatforms } from "@/server/platforms";

// An owner's platforms: the public ones to everyone, the private ones to
// members too. With none, what a platform is and, for those who may add one
// here, how to.
export default async function OwnerPlatformsPage({ params }: { params: Promise<{ owner: string }> }) {
  const { owner: slug } = await params;
  const { db, viewer } = await pageContext();
  const found = await ownerPlatforms(db, viewer, slug);
  if (!found) notFound();
  const { owner, member, platforms } = found;
  const name = owner.name || owner.slug;
  return (
    <>
      <section className="inv-head">
        {owner.type === "organisation" && member ? (
          <OrgTabs organisation={owner} current="platforms" />
        ) : (
          <p className="crumb">
            <Link href={`/${owner.slug}`}>{owner.slug}</Link> / platforms
          </p>
        )}
        <h1>{`${name}'s platforms`}</h1>
        <p>Where work can run, and what each place offers.</p>
      </section>

      {platforms.length > 0 ? (
        <section className="pf-page">
          <PlatformList platforms={platforms} />
          {member && <ShortHelp />}
        </section>
      ) : (
        <section className="pf-page">
          <p className="pf-none">{member ? `${name} has no platforms yet.` : `${name} has no public platforms.`}</p>
          <div className={member ? "pf-help" : "pf-help one"}>
            <WhatAPlatformIs />
            {member && <AddPlatform owner={owner} />}
          </div>
          <p className="pf-more">
            {!member &&
              (owner.type === "organisation"
                ? `Only members of ${name} can add platforms here. `
                : `Only ${name} can add platforms here. `)}
            Other people publish platforms too. <Link href="/platforms">See shared platforms</Link>.
          </p>
        </section>
      )}
    </>
  );
}
