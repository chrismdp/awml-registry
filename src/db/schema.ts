import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date());

// Better Auth's own tables. `username` is ours: it shares one namespace with
// organisation slugs.

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  username: text("username").unique(),
  createdAt: createdAt(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// The registry's tables.

export const organisation = sqliteTable("organisation", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const membership = sqliteTable(
  "membership",
  {
    id: id(),
    organisationId: text("organisation_id")
      .notNull()
      .references(() => organisation.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "member"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("membership_org_user_idx").on(t.organisationId, t.userId)],
);

export const workflow = sqliteTable(
  "workflow",
  {
    id: id(),
    ownerUserId: text("owner_user_id").references(() => user.id),
    ownerOrganisationId: text("owner_organisation_id").references(() => organisation.id),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    visibility: text("visibility", { enum: ["public", "private"] }).notNull(),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("workflow_user_slug_idx").on(t.ownerUserId, t.slug),
    uniqueIndex("workflow_org_slug_idx").on(t.ownerOrganisationId, t.slug),
    index("workflow_visibility_updated_idx").on(t.visibility, t.updatedAt),
    check(
      "workflow_one_owner",
      sql`(${t.ownerUserId} IS NULL) <> (${t.ownerOrganisationId} IS NULL)`,
    ),
  ],
);

export const version = sqliteTable(
  "version",
  {
    id: id(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflow.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    pushedBy: text("pushed_by").notNull().references(() => user.id),
    pushedAt: integer("pushed_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    security: text("security"),
    platform: text("platform"),
    check: text("check", { mode: "json" }).notNull().$type<CheckResult>(),
    summary: text("summary", { mode: "json" }).notNull().$type<StoredSummary>(),
  },
  (t) => [uniqueIndex("version_workflow_number_idx").on(t.workflowId, t.number)],
);

export const token = sqliteTable(
  "token",
  {
    id: id(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    hash: text("hash").notNull().unique(),
    createdAt: createdAt(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("token_user_idx").on(t.userId)],
);

export const auditEvent = sqliteTable(
  "audit_event",
  {
    id: id(),
    organisationId: text("organisation_id")
      .notNull()
      .references(() => organisation.id),
    actorId: text("actor_id").notNull().references(() => user.id),
    action: text("action", {
      enum: ["push", "private_view", "member_joined", "member_left"],
    }).notNull(),
    target: text("target").notNull(),
    at: integer("at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index("audit_event_org_at_idx").on(t.organisationId, t.at)],
);

export type CheckResult = { security?: string[]; platform?: string[] };
export type StoredSummary = { counts: Record<string, number> };
