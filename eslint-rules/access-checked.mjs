// Every route that reads a workflow, a platform, a version, an owner's list,
// an inventory, an organisation's members or its audit log goes through the
// functions in src/server that apply the access check, before it reads
// anything else. Those functions call isOwnerOrMember (src/server/owners.ts)
// or organisationToManage (src/server/organisations.ts), which is what makes a
// private workflow or platform a 404 to anyone outside its organisation.
// visiblePlatforms, which lists platforms across owners, keeps to the public
// ones and those of the viewer's own organisations in its query.

// The checked ways in, by file: src/server/registry.ts, src/server/platforms.ts,
// src/server/fit.ts and src/server/organisations.ts.
export const ENTRY_POINTS = [
  "readWorkflow",
  "readVersion",
  "pushVersion",
  "ownerPage",
  "inventory",
  "readPlatformVersion",
  "pushPlatformVersion",
  "ownerPlatforms",
  "visiblePlatforms",
  "fitWorkflow",
  "organisationToManage",
  "addMember",
  "removeMember",
];

// Reads that only an organisation's owners may make.
const OWNERS_ONLY = ["listAudit", "listMembers"];

// Routes under an owner or an organisation, and the platforms' files. Not
// /api/v1/me, which is the caller's own account and names no owner.
const OWNER_SCOPED = /\/src\/app\/(\[owner\]|api\/v1(?!\/me\/)|api\/orgs\/\[org\]|platforms)\//;

const DATA_IMPORTS = /^(@\/db\/schema|drizzle-orm)(\/|$)/;

const isGetDb = (node) =>
  node?.type === "AwaitExpression"
    ? isGetDb(node.argument)
    : node?.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "getDb";

const isDb = (node) => (node?.type === "Identifier" && node.name === "db") || isGetDb(node);

function calleeName(callee) {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
    return isDb(callee.object) ? `db.${callee.property.name}` : callee.property.name;
  }
  return null;
}

export default {
  meta: {
    type: "problem",
    docs: { description: "Owner-scoped routes read data only after the access check" },
    schema: [],
    messages: {
      unchecked: `{{name}} reads data before the access check. Call one of ${ENTRY_POINTS.join(", ")} first (src/server/registry.ts, src/server/organisations.ts): they apply isOwnerOrMember or organisationToManage, so a private workflow is a 404 to non-members.`,
      noCheck: `This route takes the database but never calls the access check. Read through one of ${ENTRY_POINTS.join(", ")}, which apply isOwnerOrMember or organisationToManage, so a private workflow is a 404 to non-members.`,
      ownersOnly:
        "Call organisationToManage before {{name}}: only an organisation's owners may see its members and audit log, and anyone else must get a 403 or a 404.",
      directData:
        "Routes do not import {{source}}. Read data through the checked functions in src/server, so the access check that makes a private workflow a 404 to non-members cannot be skipped.",
    },
  },
  create(context) {
    const scoped = OWNER_SCOPED.test(context.filename.replace(/\\/g, "/"));
    let checked = false;
    let ownerChecked = false;
    let takesDb = null;
    let flagged = false;
    return {
      ImportDeclaration(node) {
        if (DATA_IMPORTS.test(node.source.value))
          context.report({ node: node.source, messageId: "directData", data: { source: node.source.value } });
      },
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (name === "getDb" || name === "pageContext") {
          takesDb ??= node;
          return;
        }
        if (ENTRY_POINTS.includes(name)) {
          checked = true;
          if (name === "organisationToManage") ownerChecked = true;
          return;
        }
        if (OWNERS_ONLY.includes(name)) {
          if (!ownerChecked) context.report({ node, messageId: "ownersOnly", data: { name } });
          return;
        }
        const readsData = (name ?? "").startsWith("db.") || node.arguments.some(isDb);
        if (scoped && readsData && !checked) {
          flagged = true;
          context.report({ node, messageId: "unchecked", data: { name: name ?? "this call" } });
        }
      },
      "Program:exit"() {
        if (scoped && takesDb && !checked && !flagged) context.report({ node: takesDb, messageId: "noCheck" });
      },
    };
  },
};
