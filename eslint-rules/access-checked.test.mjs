import rule from "./access-checked.mjs";
import { tester } from "./tester.mjs";

const at = (path) => `/repo/src/app/${path}`;

tester.run("access-checked", rule, {
  valid: [
    {
      name: "an API route reads through readWorkflow",
      filename: at("api/v1/[owner]/[slug]/route.ts"),
      code: `export async function GET(req, { params }) {
        const { owner, slug } = await params;
        const found = await readWorkflow(await getDb(), await getViewer(req.headers), owner, slug);
        return found ? json(found) : notFound();
      }`,
    },
    {
      name: "a push goes through pushVersion",
      filename: at("api/v1/[owner]/[slug]/versions/route.ts"),
      code: `const db = await getDb(); const pushed = await pushVersion(db, viewer, owner, slug, body);`,
    },
    {
      name: "the settings page checks the owner before listing members and the audit log",
      filename: at("[owner]/settings/page.tsx"),
      code: `const { db, viewer } = await pageContext();
        const org = await organisationToManage(db, viewer?.id, owner);
        const members = await listMembers(db, org.organisation.id);
        const audit = await listAudit(db, org.organisation.id);`,
    },
    {
      name: "a page that reads nothing itself",
      filename: at("[owner]/[slug]/page.tsx"),
      code: `export default async function P({ params }) { const { owner, slug } = await params; return <V {...await loadVersion(owner, slug, "latest")} />; }`,
    },
    {
      name: "an organisation form route goes through addMember",
      filename: at("api/orgs/[org]/members/route.ts"),
      code: `const added = await addMember(await getDb(), viewer?.id, org, identifier, "member");`,
    },
    {
      name: "a route that is not owner-scoped reads the public gallery",
      filename: at("gallery/page.tsx"),
      code: `const { db } = await pageContext(); const rows = await explore(db, q);`,
    },
  ],
  invalid: [
    {
      name: "an owner-scoped route that reads before any access check",
      filename: at("[owner]/[slug]/v/[n]/[file]/route.ts"),
      code: `const db = await getDb(); const v = await findVersion(db, owner, slug, n);`,
      errors: [{ messageId: "unchecked", data: { name: "findVersion" } }],
    },
    {
      name: "an owner-scoped route that queries the database itself",
      filename: at("api/v1/[owner]/[slug]/route.ts"),
      code: `const db = await getDb(); const rows = await db.select().from(workflow);`,
      errors: [{ messageId: "unchecked", data: { name: "db.select" } }],
    },
    {
      name: "an owner-scoped route that takes the database and never checks access",
      filename: at("[owner]/page.tsx"),
      code: `const { db, viewer } = await pageContext(); return null;`,
      errors: [{ messageId: "noCheck" }],
    },
    {
      name: "a check that comes after the read is too late",
      filename: at("[owner]/inventory/page.tsx"),
      code: `const { db, viewer } = await pageContext(); const rows = await latestSummaries(db, owner); const inv = await inventory(db, viewer, owner);`,
      errors: [{ messageId: "unchecked", data: { name: "latestSummaries" } }],
    },
    {
      name: "any route importing the schema or drizzle",
      filename: at("gallery/page.tsx"),
      code: `import { workflow } from "@/db/schema"; import { eq } from "drizzle-orm";`,
      errors: [
        { messageId: "directData", data: { source: "@/db/schema" } },
        { messageId: "directData", data: { source: "drizzle-orm" } },
      ],
    },
    {
      name: "the audit log read anywhere without organisationToManage first",
      filename: at("audit/page.tsx"),
      code: `const { db } = await pageContext(); const audit = await listAudit(db, orgId);`,
      errors: [{ messageId: "ownersOnly", data: { name: "listAudit" } }],
    },
    {
      name: "members listed before the owner check",
      filename: at("[owner]/settings/page.tsx"),
      code: `const { db, viewer } = await pageContext(); const m = await listMembers(db, id); const org = await organisationToManage(db, viewer?.id, owner);`,
      errors: [{ messageId: "ownersOnly", data: { name: "listMembers" } }],
    },
  ],
});
