import { notFound, permanentRedirect } from "next/navigation";
import { mistakesIn, type CheckedFile, type CheckRow } from "@/components/Checks";
import type { VersionViewProps } from "@/components/VersionView";
import type { Db } from "@/db/client";
import { engine, type ListedCheck } from "@/engine";
import { asRead } from "@/server/as-read";
import { refPath, refsAsSeen } from "@/server/refs";
import { awmlOf, implementationsOf, partKinds } from "@/server/awml-file";
import { followOldName, isPageView, pageContext, underOwner, workflowPath, type PageView } from "@/server/page";
import { layOut } from "@/server/drawing";
import { partLinks } from "@/server/part-links";
import { organisationsOf } from "@/server/organisations";
import { forksOf, readVersion, referrersOf, systemsWith, VIEWS, type FileName, type View } from "@/server/registry";
import type { Viewer } from "@/server/viewer";

// One version for its page, `n` or "latest", with the view asked for: a view
// drawn, every file as text for "yaml", or what checking them found for
// "checks". With no view asked for, the security view is drawn, or a version
// stored before 0.4 draws the first file it has.
//
// A workflow is one file: its security view draws the design, and its
// platform view draws one implementation, the first unless `implementation`
// names another. A 404 for anyone who may not see the version, for an
// implementation it does not have, and for a view a version stored before
// has no file for.
//
// Every file is shown as text as it was pushed, and drawn and checked as the
// engine reads it: converted, when it is in an older AWML (see
// src/server/as-read.ts). What converting it noted for its author to do by
// hand is shown on its YAML and Checks tabs. A file that can't be converted
// is not drawn, and its Checks say why.
//
// A workflow file pushed since AWML listed its checks shows the list stored
// at push, one row per check, named by the AWML that ran them. A workflow
// file pushed before has its checks listed now, the same way, by the AWML
// the registry runs, and so has a listed file the AWML here finds mistakes
// in: a push with a mistake is refused, so only a newer AWML can find some,
// and then the page shows them. A list made now is never stored. A file
// stored before 0.4 is checked again here with `awml check`, which lists no
// checks, so the page can name that AWML truly.
export async function loadVersion(
  owner: string,
  slug: string,
  n: string,
  asked?: PageView,
  implementation?: string,
): Promise<VersionViewProps> {
  // The engine starts, the first time, while the database is read; should it
  // fail, the first call that needs it says so. The start isn't awaited, so a
  // later request may await it after this one has ended. On a Worker that is
  // safe only because it uses no timer or I/O of this request, which workerd
  // would cancel with the request: the module comes compiled, and Go sets
  // AWML's functions before its run returns. If it ever needs either, pass it
  // to getCloudflareContext().ctx.waitUntil.
  engine.start().catch(() => {});
  const context = await pageContext();
  const v = await readVersion(context.db, context.viewer, owner, slug, n === "latest" ? "latest" : n);
  if (!v) {
    const rest = underOwner(slug, n, asked) + (implementation ? `/${encodeURIComponent(implementation)}` : "");
    await followOldName(context.db, owner, rest);
    notFound();
  }
  return versionProps(context, v, n, asked, implementation);
}

// A version as `viewer` may see its page, once it has been read for them: a
// workflow's embed (#75) gives it nobody, as someone signed out.
export async function versionProps(
  { db, viewer }: { db: Db; viewer: Viewer },
  v: NonNullable<Awaited<ReturnType<typeof readVersion>>>,
  n: string,
  asked?: PageView,
  implementation?: string,
): Promise<VersionViewProps> {
  const address = workflowPath(v.owner, v.slug, n === "latest" ? "latest" : v.number);
  const workflow = v.files.workflow;
  const views: View[] = workflow ? [...VIEWS] : VIEWS.filter((view) => v.files[view] !== undefined);
  const names: FileName[] = workflow ? ["workflow"] : views;
  const read = new Map(await Promise.all(names.map(async (name) => [name, await asRead(v.files, name)] as const)));
  const readFile = (name: FileName) => {
    const r = read.get(name);
    return r && "file" in r ? r.file : undefined;
  };
  const implementations = workflow ? implementationsOf(readFile("workflow") ?? workflow) : [];
  if (implementation !== undefined && !implementations.some((i) => i.id === implementation)) notFound();

  if ((asked === "security" || asked === "platform") && !views.includes(asked)) notFound();
  const shown = asked ?? views[0];
  const notesOf = (name: FileName) => {
    const r = read.get(name);
    return r && "file" in r ? r.notes : [];
  };
  const files = names.map((name) => ({ name, text: v.files[name]!, awml: awmlOf(v.files[name]), notes: notesOf(name) }));
  const checks: CheckedFile[] = await Promise.all(
    files.map(async (f): Promise<CheckedFile> => {
      const r = read.get(f.name)!;
      if ("error" in r)
        return {
          name: f.name,
          checkedBy: engine.version,
          listed: false,
          rows: [{ name: "awml convert", mistakes: r.error, warnings: [] }],
        };
      const notes = r.notes.length ? { notes: r.notes } : {};
      if (f.name === "workflow") {
        const stored = v.checks && (await engine.check(r.file)).length === 0 ? v.checks : null;
        const list = stored ?? { awml: engine.version, checks: await engine.checks(r.file) };
        return { name: f.name, checkedBy: list.awml, listed: stored ? "stored" : "now", rows: rowsOf(list.checks), ...notes };
      }
      return {
        name: f.name,
        checkedBy: engine.version,
        listed: false,
        rows: [{ name: "awml check", mistakes: await engine.check(r.file), warnings: await engine.warnings(r.file) }],
        ...notes,
      };
    }),
  );

  // A workflow's refs, as the viewer may know what each names. Refs follow
  // the latest version of what they name, so when the viewer may see any of
  // it, the Checks tab lists the checks now, of the file given with each
  // workflow its refs name that the viewer may see. The file still checks
  // alone, so whether it is drawn goes by its checks alone.
  //
  // The reads besides the version don't depend on each other, so they run at
  // once rather than one after another.
  const workflowRead = workflow ? readFile("workflow") : undefined;
  const [refs, forks, referredBy, systems, organisations] = await Promise.all([
    workflowRead ? refsAsSeen(db, viewer, v.owner, v.slug, workflowRead) : { shown: [], given: [] },
    forksOf(db, viewer, v.owner, v.slug),
    referrersOf(db, viewer, v.owner, v.slug),
    systemsWith(db, viewer, v.owner, v.slug),
    v.visibility === "public" && viewer ? organisationsOf(db, viewer.id) : [],
  ]);
  const shownChecks: CheckedFile[] = refs.given.length
    ? await Promise.all(
        checks.map(async (f) =>
          f.name !== "workflow"
            ? f
            : {
                ...f,
                checkedBy: engine.version,
                listed: "now" as const,
                rows: rowsOf(await engine.checksWith({ file: refPath(v.owner, v.slug), source: workflowRead! }, refs.given)),
              },
        ),
      )
    : checks;

  // The file the shown view is drawn from, and for a workflow's platform view,
  // the implementation drawn, if it has any. A platform view stored before
  // 0.4 converts into a workflow whose one implementation it draws.
  const placed = shown === "platform" ? (implementation ?? implementations[0]?.id) : undefined;
  const source: FileName | undefined = workflow ? "workflow" : views.find((view) => view === shown);
  const nowhere = Boolean(workflow) && shown === "platform" && !placed;
  // Only the security and platform views show a drawing, so only they draw.
  const drawn = shown === "security" || shown === "platform";
  const drawable = drawn && source && !nowhere && mistakesIn(checks.filter((c) => c.name === source)) === 0;
  // A public workflow can be forked into the viewer's own account or one of
  // their organisations; someone signed out is asked to sign in first.
  const fork =
    v.visibility !== "public"
      ? null
      : viewer
        ? { owners: [viewer.username, ...organisations.map((o) => o.slug)] }
        : { signIn: `/login?${new URLSearchParams({ next: address })}` };
  return {
    owner: v.owner,
    slug: v.slug,
    title: v.title,
    visibility: v.visibility,
    number: v.number,
    forked: v.forked,
    forkedFrom: v.forkedFrom,
    forks: forks ?? { total: 0, forks: [] },
    fork,
    address,
    // The page's own address draws the security view whenever a version has
    // one, so the security view's links leave it off, as the same page.
    tab: (asked && asked !== "security" ? `/${asked}` : "") + (implementation ? `/${encodeURIComponent(implementation)}` : ""),
    views,
    shown,
    drawnFrom: source ?? "workflow",
    implementations: implementations.map((i) => ({
      ...i,
      href: `${address}/platform/${encodeURIComponent(i.id)}`,
      shown: i.id === placed,
    })),
    nowhere,
    files,
    checks: shownChecks,
    refs: refs.shown,
    referredBy: referredBy ?? [],
    // The parts the drawing marks as linked to other workflows, from what the
    // viewer may know of both, so it names nothing they can't see.
    links: partLinks(refs.shown, referredBy ?? [], workflowRead ? partKinds(workflowRead) : new Map()),
    systems: systems ?? [],
    // The drawing, laid out here from the engine's graph (src/server/drawing.ts),
    // so the page draws it with no layout of its own.
    drawing: drawable ? await layOut(await engine.graph(readFile(source)!, drawnImplementation(source, placed, readFile(source)!))) : null,
    summary: v.summary,
    versions: v.versions,
  };
}

// Each check AWML listed, as a row of the Checks tab.
export function rowsOf(checks: ListedCheck[]): CheckRow[] {
  return checks.map(({ name, mistakes, ...listed }) => ({
    name,
    mistakes: listed.result === "fail" ? mistakes : [],
    warnings: listed.result === "warn" ? mistakes : [],
    listed,
  }));
}

// The implementation a view draws of a file as the engine reads it: the one
// placed for a workflow's platform view, the only one a platform view stored
// before 0.4 converts into, and none for a security view.
function drawnImplementation(source: FileName, placed: string | undefined, file: string) {
  if (source === "platform") return implementationsOf(file)[0]?.id;
  return placed;
}

// The old address of a view, such as ?view=platform, sent for good (308) to
// the view's own path. It reads nothing first, so it answers the same for a
// private workflow as for a missing one; the page it sends to makes the check.
export function followOldView(owner: string, slug: string, n: string, asked: string | string[] | undefined) {
  if (isPageView(asked)) permanentRedirect(workflowPath(owner, slug, n, asked));
}
