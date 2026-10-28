import { notFound } from "next/navigation";
import { rowsOf } from "@/app/[owner]/[slug]/load";
import type { CheckedFile } from "@/components/Checks";
import type { ListedMember, SystemPanel, SystemViewProps } from "@/components/SystemView";
import type { Db } from "@/db/client";
import { engine, type Named } from "@/engine";
import { layOut, mapLinks } from "@/server/drawing";
import { asRead, descriptionAsRead } from "@/server/as-read";
import { followOldName, pageContext, systemPath, underOwner, type SystemTab } from "@/server/page";
import { notePrivatePlatformView, visiblePlatforms } from "@/server/platforms";
import { refPath } from "@/server/refs";
import { readSystemVersion } from "@/server/systems";
import type { Viewer } from "@/server/viewer";

// One system version for its page, `n` or "latest", with the tab asked for.
// A 404 for anyone who may not see it.
//
// Each member the viewer may see is given to the engine as its latest
// version, as the engine reads it (converted, when stored in an older AWML),
// at a path ending owner/slug.yaml, so the refs between members are
// followed. A member the viewer may not see is given to nothing. The Checks
// tab checks every member together; a member that doesn't pass check on its
// own is listed as not drawn and left out of the map, who waits and where it
// runs, as a workflow with mistakes is not drawn.
export async function loadSystem(owner: string, slug: string, n: string, tab: SystemTab): Promise<SystemViewProps> {
  const context = await pageContext();
  const s = await readSystemVersion(context.db, context.viewer, owner, slug, n === "latest" ? "latest" : n);
  if (!s) {
    await followOldName(context.db, owner, `/systems${underOwner(slug, n, tab === "map" ? undefined : tab)}`);
    notFound();
  }
  return systemProps(context, s, n, tab);
}

// A system version as `viewer` may see its page, once it has been read for
// them: a system's embed (#75) gives it nobody, as someone signed out, so a
// member they may not see is left out exactly as it is for them.
export async function systemProps(
  { db, viewer }: { db: Db; viewer: Viewer },
  s: NonNullable<Awaited<ReturnType<typeof readSystemVersion>>>,
  n: string,
  tab: SystemTab,
): Promise<SystemViewProps> {
  const read = await Promise.all(
    s.members.map(async (m) => {
      if (m.state !== "found") return { member: m, file: null, error: null };
      const name = m.files.workflow !== undefined ? "workflow" : m.files.security !== undefined ? "security" : null;
      const r = name ? await asRead(m.files, name) : { error: ["It has no workflow file the registry can read."] };
      if ("error" in r) return { member: m, file: null, error: r.error };
      const named: Named = { file: refPath(m.owner, m.slug), source: r.file };
      return { member: m, file: named, error: null, drawn: (await engine.check(r.file)).length === 0 };
    }),
  );
  const given = read.flatMap((r) => (r.file ? [r.file] : []));
  const drawn = read.flatMap((r) => (r.file && r.drawn ? [r.file] : []));
  const listed = given.length ? await engine.checksAcross(given) : [];
  const checks: CheckedFile[] = read.flatMap((r): CheckedFile[] => {
    if (r.member.state !== "found") return [];
    const name = `${r.member.owner}/${r.member.slug}` as const;
    if (r.error)
      return [{ name, checkedBy: engine.version, listed: false, rows: [{ name: "awml convert", mistakes: r.error, warnings: [] }] }];
    const found = listed.find((l) => l.file === r.file!.file)!;
    return [{ name, checkedBy: engine.version, listed: "now", rows: rowsOf(found.checks) }];
  });

  const members: ListedMember[] = read.map((r) =>
    r.member.state === "found"
      ? {
          state: "found",
          owner: r.member.owner,
          slug: r.member.slug,
          title: r.member.title,
          visibility: r.member.visibility,
          drawn: Boolean(r.file && r.drawn),
        }
      : r.member,
  );

  let panel: SystemPanel = { tab: "checks" };
  if (tab === "map") {
    // The engine names each workflow's box w1, w2 and on, in the order the
    // members drawn are given to it, and is given only members the viewer
    // may see, so a box never leads to a workflow they may not see (#61).
    const boxes = read.flatMap((r) =>
      r.file && r.drawn && r.member.state === "found"
        ? [{ title: r.member.title, address: `${r.member.owner}/${r.member.slug}`, href: `/${r.member.owner}/${r.member.slug}` }]
        : [],
    );
    const hrefs = Object.fromEntries(boxes.map((b, i) => [`w${i + 1}`, b.href]));
    panel = {
      tab,
      ...(await attempt(async () => {
        if (!drawn.length) return {};
        const drawing = await layOut(await engine.drawMap(drawn), { map: true });
        if ("undrawn" in drawing) return { drawing };
        return { drawing, hrefs, links: mapLinks(drawing.full, Object.fromEntries(boxes.map((b, i) => [`w${i + 1}`, b]))) };
      })),
    };
  }
  if (tab === "who-waits")
    panel = { tab, ...(await attempt(async () => (drawn.length ? { summary: await engine.summariseAcross(drawn) } : {}))) };
  if (tab === "where-it-runs") {
    // The platforms of the system's owner the viewer may see, and the public
    // ones, each judged running every member drawn; each private one judged
    // is recorded as viewed, as the fit records it.
    const platforms = drawn.length
      ? (await visiblePlatforms(db, viewer)).filter((p) => p.visibility === "public" || p.owner === s.owner.slug)
      : [];
    panel = {
      tab,
      ...(await attempt(async () => {
        if (!drawn.length) return {};
        const fits = [];
        for (const p of platforms) {
          const report = await engine.fitAcross(drawn, [await descriptionAsRead(p.description)]);
          if (report.gaps.length) return { gaps: report.gaps, fits: [] };
          for (const r of report.results)
            fits.push({ owner: p.owner, slug: p.slug, label: p.label, fits: r.fits, reasons: r.reasons });
        }
        for (const p of platforms)
          await notePrivatePlatformView(db, viewer, { type: p.ownerType, id: p.ownerId, slug: p.owner }, p, p.number);
        return { gaps: [], fits };
      })),
    };
  }

  return {
    owner: s.owner.slug,
    slug: s.slug,
    title: s.title,
    description: s.description,
    visibility: s.visibility,
    number: s.number,
    address: systemPath(s.owner.slug, s.slug, n === "latest" ? "latest" : s.number),
    tab,
    members,
    hidden: s.hidden,
    checks,
    panel,
    versions: s.versions,
  };
}

// What the engine gave, or the mistakes it threw, such as two members whose
// copies of a part disagree, which stop the map, the summary and the fit.
async function attempt<T extends object>(work: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await work();
  } catch (e) {
    return { error: (e as Error).message };
  }
}
