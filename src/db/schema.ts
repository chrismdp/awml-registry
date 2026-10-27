import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { ListedCheck, Summary } from "@/engine/types";

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

// Better Auth's MCP plugin, the OAuth 2.1 provider that lets an AI client sign
// in to /mcp, and the JWT plugin whose keys sign its access tokens. The columns
// are what Better Auth generates for SQLite; lists and objects are JSON text.

export const jwks = sqliteTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  alg: text("alg"),
  crv: text("crv"),
});

export const oauthClient = sqliteTable(
  "oauth_client",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    clientDiscoveryId: text("client_discovery_id"),
    disabled: integer("disabled", { mode: "boolean" }).default(false),
    skipConsent: integer("skip_consent", { mode: "boolean" }),
    enableEndSession: integer("enable_end_session", { mode: "boolean" }),
    subjectType: text("subject_type"),
    scopes: text("scopes", { mode: "json" }),
    clientCredentialsScopes: text("client_credentials_scopes", { mode: "json" }).default([]),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts", { mode: "json" }),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris", { mode: "json" }).notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris", { mode: "json" }),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: integer("backchannel_logout_session_required", { mode: "boolean" }),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    applicationType: text("application_type"),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    grantTypes: text("grant_types", { mode: "json" }),
    responseTypes: text("response_types", { mode: "json" }),
    requirePKCE: integer("require_pkce", { mode: "boolean" }),
    dpopBoundAccessTokens: integer("dpop_bound_access_tokens", { mode: "boolean" }).default(false),
    referenceId: text("reference_id"),
    metadata: text("metadata", { mode: "json" }),
  },
  (t) => [index("oauth_client_user_idx").on(t.userId)],
);

export const oauthResource = sqliteTable("oauth_resource", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("access_token_ttl"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: text("allowed_scopes", { mode: "json" }),
  customClaims: text("custom_claims", { mode: "json" }),
  dpopBoundAccessTokensRequired: integer("dpop_bound_access_tokens_required", { mode: "boolean" }).default(false),
  disabled: integer("disabled", { mode: "boolean" }).default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  policyVersion: integer("policy_version").default(1),
  metadata: text("metadata", { mode: "json" }),
});

export const oauthClientResource = sqliteTable(
  "oauth_client_resource",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: "cascade" }),
    metadata: text("metadata", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("oauth_client_resource_client_resource_idx").on(t.clientId, t.resourceId),
    index("oauth_client_resource_client_idx").on(t.clientId),
    index("oauth_client_resource_resource_idx").on(t.resourceId),
  ],
);

export const oauthRefreshToken = sqliteTable(
  "oauth_refresh_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources", { mode: "json" }),
    requestedUserInfoClaims: text("requested_user_info_claims", { mode: "json" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }),
    revoked: integer("revoked", { mode: "timestamp_ms" }),
    rotatedAt: integer("rotated_at", { mode: "timestamp_ms" }),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: integer("rotation_replay_expires_at", { mode: "timestamp_ms" }),
    authTime: integer("auth_time", { mode: "timestamp_ms" }),
    confirmation: text("confirmation", { mode: "json" }),
    scopes: text("scopes", { mode: "json" }).notNull(),
  },
  (t) => [
    index("oauth_refresh_token_client_idx").on(t.clientId),
    index("oauth_refresh_token_session_idx").on(t.sessionId),
    index("oauth_refresh_token_user_idx").on(t.userId),
    index("oauth_refresh_token_code_idx").on(t.authorizationCodeId),
  ],
);

export const oauthAccessToken = sqliteTable(
  "oauth_access_token",
  {
    id: text("id").primaryKey(),
    token: text("token").unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources", { mode: "json" }),
    requestedUserInfoClaims: text("requested_user_info_claims", { mode: "json" }),
    refreshId: text("refresh_id").references(() => oauthRefreshToken.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }),
    revoked: integer("revoked", { mode: "timestamp_ms" }),
    confirmation: text("confirmation", { mode: "json" }),
    scopes: text("scopes", { mode: "json" }).notNull(),
  },
  (t) => [
    index("oauth_access_token_client_idx").on(t.clientId),
    index("oauth_access_token_session_idx").on(t.sessionId),
    index("oauth_access_token_user_idx").on(t.userId),
    index("oauth_access_token_code_idx").on(t.authorizationCodeId),
    index("oauth_access_token_refresh_idx").on(t.refreshId),
  ],
);

export const oauthConsent = sqliteTable(
  "oauth_consent",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    resources: text("resources", { mode: "json" }),
    requestedUserInfoClaims: text("requested_user_info_claims", { mode: "json" }),
    scopes: text("scopes", { mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("oauth_consent_client_idx").on(t.clientId), index("oauth_consent_user_idx").on(t.userId)],
);

export const oauthClientAssertion = sqliteTable("oauth_client_assertion", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

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
    // A fork's source: the id of the version it was copied from. An id, not a
    // name, so a rename of the original's owner is followed; and not a foreign
    // key, so a fork of a deleted workflow still knows it is one.
    forkedFrom: text("forked_from"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("workflow_user_slug_idx").on(t.ownerUserId, t.slug),
    uniqueIndex("workflow_org_slug_idx").on(t.ownerOrganisationId, t.slug),
    index("workflow_visibility_updated_idx").on(t.visibility, t.updatedAt),
    index("workflow_forked_from_idx").on(t.forkedFrom),
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
    // An AWML workflow is one file, kept as it was pushed. Versions pushed before
    // the registry took only 0.4 files hold a security file, a platform file or both.
    workflow: text("workflow"),
    security: text("security"),
    platform: text("platform"),
    check: text("check", { mode: "json" }).notNull().$type<CheckResult>(),
    // Every check AWML ran on the workflow file at push, and the AWML that ran
    // them. Versions pushed before AWML listed its checks have none.
    checks: text("checks", { mode: "json" }).$type<CheckList>(),
    summary: text("summary", { mode: "json" }).notNull().$type<Summary>(),
  },
  (t) => [uniqueIndex("version_workflow_number_idx").on(t.workflowId, t.number)],
);

// Each ref a version's file holds to another workflow's part, as the file
// gives it after a push rewrote any path: owner/slug#id. Written at push, so a
// workflow's page can list the workflows whose latest version refers to it.
// The owner and slug are names, as in the file, since a ref may name a
// workflow not pushed yet.
export const workflowRef = sqliteTable(
  "workflow_ref",
  {
    id: id(),
    versionId: text("version_id")
      .notNull()
      .references(() => version.id, { onDelete: "cascade" }),
    part: text("part").notNull(),
    targetOwner: text("target_owner").notNull(),
    targetSlug: text("target_slug").notNull(),
    targetPart: text("target_part").notNull(),
  },
  (t) => [
    index("workflow_ref_target_idx").on(t.targetOwner, t.targetSlug),
    index("workflow_ref_version_idx").on(t.versionId),
  ],
);

// A platform a workflow can run on, described in AWML's platform description
// format. Owned like a workflow, and versioned like one.
export const platform = sqliteTable(
  "platform",
  {
    id: id(),
    ownerUserId: text("owner_user_id").references(() => user.id),
    ownerOrganisationId: text("owner_organisation_id").references(() => organisation.id),
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    visibility: text("visibility", { enum: ["public", "private"] }).notNull(),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("platform_user_slug_idx").on(t.ownerUserId, t.slug),
    uniqueIndex("platform_org_slug_idx").on(t.ownerOrganisationId, t.slug),
    index("platform_visibility_updated_idx").on(t.visibility, t.updatedAt),
    check(
      "platform_one_owner",
      sql`(${t.ownerUserId} IS NULL) <> (${t.ownerOrganisationId} IS NULL)`,
    ),
  ],
);

// One version of a platform: its description as YAML, and the install recipe
// as Markdown when it has one.
export const platformVersion = sqliteTable(
  "platform_version",
  {
    id: id(),
    platformId: text("platform_id")
      .notNull()
      .references(() => platform.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    pushedBy: text("pushed_by").notNull().references(() => user.id),
    pushedAt: integer("pushed_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    description: text("description").notNull(),
    recipe: text("recipe"),
  },
  (t) => [uniqueIndex("platform_version_platform_number_idx").on(t.platformId, t.number)],
);

// A system: several workflows given to the engine together. Owned like a
// workflow, and versioned like one.
export const system = sqliteTable(
  "system",
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
    uniqueIndex("system_user_slug_idx").on(t.ownerUserId, t.slug),
    uniqueIndex("system_org_slug_idx").on(t.ownerOrganisationId, t.slug),
    index("system_visibility_updated_idx").on(t.visibility, t.updatedAt),
    check("system_one_owner", sql`(${t.ownerUserId} IS NULL) <> (${t.ownerOrganisationId} IS NULL)`),
  ],
);

// One version of a system: its title, its description as Markdown, and its
// members (system_member).
export const systemVersion = sqliteTable(
  "system_version",
  {
    id: id(),
    systemId: text("system_id")
      .notNull()
      .references(() => system.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    pushedBy: text("pushed_by").notNull().references(() => user.id),
    pushedAt: integer("pushed_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    title: text("title").notNull(),
    description: text("description").notNull(),
  },
  (t) => [uniqueIndex("system_version_system_number_idx").on(t.systemId, t.number)],
);

// A workflow in a system's version, in the order it was pushed. It follows
// the workflow's latest version, so it records no version. The workflow is
// held by its id, so a rename of its owner is followed, and not as a foreign
// key, so a deleted one is still known to have been there; its owner and slug
// as pushed say what it was.
export const systemMember = sqliteTable(
  "system_member",
  {
    id: id(),
    versionId: text("version_id")
      .notNull()
      .references(() => systemVersion.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    workflowId: text("workflow_id").notNull(),
    owner: text("owner").notNull(),
    slug: text("slug").notNull(),
  },
  (t) => [
    index("system_member_version_idx").on(t.versionId),
    index("system_member_workflow_idx").on(t.workflowId),
  ],
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

// A username a person gave up. Its address redirects to the name they go by
// now, while no person or organisation holds it. One row per name: the last
// person to give it up.
export const previousName = sqliteTable("previous_name", {
  name: text("name").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  givenUpAt: integer("given_up_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const auditEvent = sqliteTable(
  "audit_event",
  {
    id: id(),
    organisationId: text("organisation_id")
      .notNull()
      .references(() => organisation.id),
    actorId: text("actor_id").notNull().references(() => user.id),
    action: text("action", {
      enum: ["push", "private_view", "member_joined", "member_left", "member_renamed"],
    }).notNull(),
    target: text("target").notNull(),
    at: integer("at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (t) => [index("audit_event_org_at_idx").on(t.organisationId, t.at)],
);

export type CheckResult = { workflow?: string[]; security?: string[]; platform?: string[] };

export type CheckList = { awml: { tag: string; commit: string }; checks: ListedCheck[] };
