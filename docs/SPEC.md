# AWML Registry: v1 spec

The AWML Registry stores, versions and draws AWML workflow files. Public workflows are free, and a private store for an organisation is paid on the hosted service. The code in this repo is source-available under FSL-1.1-MIT: a company may run it internally, but nobody may offer it as a competing service.

This file records what the registry does and the decisions behind it. AWML itself (spec, CLI, Go package) is MIT at github.com/chrismdp/awml; read its `SPEC.md` for what a workflow file is.

## Decisions

| Decision | Choice |
|---|---|
| Code and licence | This repo, chrismdp/awml-registry, under FSL-1.1-MIT. The AWML spec and CLI stay MIT. |
| Editions | This repo is the whole self-hostable registry and contains **no billing code**. The hosted service at awml.io is a separate private repo, chrismdp/awml-cloud, that adds Stripe billing, the marketing pages and the Cloudflare deploy settings (see "The hosted service"). This repo exposes an `edition` hook the hosted repo replaces; the default edition allows everything. |
| Address | One domain, awml.io. The registry is served from the root, so a workflow lives at `awml.io/{owner}/{slug}`, and the gallery at `awml.io/gallery`. The marketing pages belong to the hosted repo, not this one. |
| Stack | Next.js (App Router, React, TypeScript) with Drizzle ORM over SQLite. |
| Hosting | Hosted: Cloudflare Workers through the OpenNext Cloudflare adapter, data in D1. Self-hosted: the same app as a Docker container, data in a SQLite file. |
| Sign-in | GitHub, Google, and a passwordless link by email. Through Better Auth, which keeps its tables in the same database. SAML single sign-on later through Better Auth's SSO plugin. |
| Workflow checks | Uploads are checked by the AWML Go package itself, compiled to WebAssembly, so the registry and the CLI give the same verdict. |
| Files with mistakes | Refused at upload, with the messages `awml check` gives. |
| Versions | Each push is a new numbered version, 1, 2, 3, never changed afterwards. |
| AI on customer content | None: the registry never sends a workflow to a model. Customers bring their own AI through the MCP server at `/mcp`, which acts as them (see "The MCP server"). |

## What v1 does

- **Push and pull.** Push a workflow's security file, platform file or both from the CLI or the API. Every version can be downloaded as YAML or pulled with the CLI.
- **A page per version.** Both views drawn (Mermaid, drawn in the browser from the text the AWML package produces), the check result, and the summary worked out from the files at push.
- **A public gallery.** Anyone can browse public workflows and search them by title. Anyone signed in can publish one, free.
- **Private workflows for an organisation.** Only its members can see them. In this repo's default edition every organisation may keep private workflows; the hosted edition limits that to paying organisations.
- **An inventory for each organisation.** Every workflow in one table with its summary counts, plus totals across them all.
- **An audit log for each organisation.** Who pushed, who viewed a private workflow, who joined or left. Owners can read it; nobody can change it.

## Data

| Table | Holds |
|---|---|
| User, session, account, verification | Better Auth's own tables |
| Organisation | Slug, name, created at |
| Membership | A user in an organisation, as `owner` or `member` |
| Workflow | Owner (a user or an organisation, never both), slug, title, `public` or `private` |
| Version | Workflow, number, who pushed it and when, at most one security file and one platform file (YAML text), the check result, the summary as JSON |
| Token | User, name, SHA-256 hash of the secret (the secret is shown once), created at, last used at |
| Audit event | Organisation, actor, action, target, at. Rows are only ever added |
| OAuth clients, consents, access and refresh tokens, resources; JWKS | Better Auth's MCP plugin and JWT plugin keep these for AI clients signing in to `/mcp` |

User slugs and organisation slugs share one namespace. Reserved slugs that no user or organisation may take: `api`, `explore`, `gallery`, `settings`, `login`, `logout`, `signup`, `auth`, `new`, `admin`, `pricing`, `security`, `docs`, `about`, `blog`, `terms`, `privacy`, `help`, `status`, `_next`, `static`, `assets`, `mcp`, `consent`.

## Pages, API and CLI

| Route or command | What it does |
|---|---|
| `/` | In this repo: the gallery. The hosted edition puts its home page here |
| `/gallery` | The gallery of public workflows, newest first, with search by title |
| `/explore` | Where the gallery was. Redirects permanently (308) to `/gallery`, keeping the search |
| `/{owner}` | A user's or organisation's workflows: the public ones to everyone, the private ones to members too |
| `/{owner}/{slug}` | The latest version: both views drawn, the summary, the check result, the list of versions, and the command to push the next one |
| `/{owner}/{slug}/v/{n}` | One version, the same way |
| `/{owner}/{slug}/v/{n}/{view}.yaml` | One file as YAML |
| `/{org}/inventory` | The organisation's inventory, for members |
| `/{org}/settings` | Members and the audit log, for owners (the hosted edition adds billing) |
| `/settings/tokens` | Make and revoke API tokens |
| `POST /api/v1/{owner}/{slug}/versions` | Push a version. Body JSON `{"security": "<yaml>"?, "platform": "<yaml>"?, "visibility": "public"\|"private"?}`, at least one file. The first push makes the workflow and sets its visibility (default public). Returns 201 with `{owner, slug, number, url}`, or 422 with `{errors: [...]}` |
| `GET /api/v1/{owner}/{slug}` | The workflow and its list of versions |
| `GET /api/v1/{owner}/{slug}/v/{n}` | One version's files, check result and summary |
| `awml login` | Asks for a token made on the website, and saves it in `~/.config/awml/credentials`, readable only by its owner |
| `awml push owner/slug security.yaml platform.yaml [--private]` | Checks the files locally, then pushes them |
| `awml pull owner/slug[@n] [-o dir]` | Downloads the files of the latest version, or of version n |
| `/mcp` | The MCP server, streamable HTTP (see "The MCP server") |
| `/.well-known/oauth-protected-resource[/mcp]` | Where `/mcp` says its sign-in lives (RFC 9728) |
| `/.well-known/oauth-authorization-server[/api/auth]` | The sign-in server's metadata (RFC 8414): registration, authorisation and token endpoints under `/api/auth/oauth2/` |
| `/consent` | Where a person lets an AI client act as them, after signing in at `/login` |

The API takes `Authorization: Bearer <token>` or a browser session. The CLI talks to `https://awml.io` unless `--registry` or `AWML_REGISTRY_URL` names another.

## Access

A private workflow is visible to its organisation's members and to nobody else.

- **Public workflows** can be read by anyone, signed in or not. Only their owner can push to them: the user, or the organisation's members.
- **Private workflows** can be read only by members. Anyone else gets a 404, the same as for a workflow that doesn't exist, so a private workflow's name never leaks.
- **Owners** manage members. **Members** read and push. A token acts as its user and can do nothing more. So does an AI client's OAuth token, on `/mcp` only.
- **A token that is not valid**, revoked or mistyped, gets a 401 that says to log in again, from the API, the YAML downloads and the organisation forms alike. It gets the same answer whatever it asks for, so it never learns whether a private workflow exists. A request with no `Authorization` header is anonymous. Decided 2026-10-22, after a self-hosting trial found a revoked token silently read as nobody.
- A user's own workflows (owner is a user) are public only in v1; private workflows belong to organisations.

Each boundary has a test:

| Boundary | Test |
|---|---|
| Positive | A member can read and push a private workflow |
| Negative | A non-member and a signed-out visitor both get 404 on a private workflow, its files, its version pages and its API |
| Cross-tenant | A token from a member of organisation A can neither read nor push organisation B's workflows, public pushes included |
| Invalid token | A revoked or made-up token gets the same 401 for a private, a public and a missing workflow; a valid token still reads as before |
| Roles | An owner can do everything a member can, and manage members. A member cannot manage members or read the audit log |

## The edition hook

`src/edition.ts` exports one object the hosted repo replaces with its own file. In v1 it carries:

- `canKeepPrivate(org): Promise<boolean>`: whether the organisation may push a private workflow. Default: `true`.
- `canPush(org): Promise<boolean>`: whether the organisation may push at all (the hosted edition says no after a lapsed payment; reading stays allowed). Default: `true`.
- `homePage`: optional React component for `/`. Default: the gallery.
- `legalLinks`: optional addresses of the terms and the privacy policy, `{ terms, privacy }`, which the sign-in page links to. Default: none, and the sign-in page names neither. The hosted edition sets `/terms` and `/privacy`, its own pages.

Nothing else in this repo knows that billing exists.

## The hosted service

awml.io is built from chrismdp/awml-cloud, a private repo that holds this one as a submodule pinned to a commit. Its build copies this repo, lays its own files over it at the same paths and deploys the result. Everything specific to awml.io lives there, not here:

- `src/edition.ts`, with the home page about the AWML spec and the links to its terms and privacy policy.
- `/terms` and `/privacy`, which name the company that runs awml.io.
- `wrangler.jsonc` with awml.io's settings: the route, the D1 database, `BETTER_AUTH_URL` and `MAIL_FROM`.
- The deploy to awml.io on each push to its main branch.

This repo's `wrangler.jsonc` has placeholders for a self-hoster to fill in, and its CI only type checks, lints and tests. Moved out on 2026-10-22.

## The MCP server

Added after v1, on 2026-10-22. A person connects their own AI (Claude.ai, Claude Desktop, ChatGPT, Claude Code, Codex) to `<registry>/mcp` and asks it to check, read or publish workflows. It runs on their account, not ours; the registry still sends nothing to a model.

**Tools.** Each calls the same functions in `src/server` as the website and the API, so it sees what the person may see and the audit log records the same events (`push` on publish, `private_view` on reading a private workflow).

| Tool | What it does |
|---|---|
| `check` | Checks a security file, a platform file or both with the AWML engine, and gives the mistakes. Saves nothing |
| `publish` | Saves a new version of `owner/slug`, by the same rules as `POST /api/v1/{owner}/{slug}/versions`. Gives the page `<registry>/{owner}/{slug}` and the version number |
| `get` | A workflow's YAML, check result and summary, the latest version or a given one |
| `list` | An owner's workflows the person may see; with no owner, their own and their organisations' |
| `search` | The public gallery by title |

**Signing in, two ways, both the same person.**

- OAuth 2.1 through Better Auth's MCP plugin (`@better-auth/mcp`), with dynamic client registration. An AI client finds it from the address alone: `/mcp` answers a request without a token with a 401 whose `WWW-Authenticate` names the protected resource metadata, which names the sign-in server. The person signs in on `/login` as usual and allows the client on `/consent`. The access token is a JWT for `/mcp` only.
- `Authorization: Bearer <registry token>`, a token from `/settings/tokens`, for clients that take a header.

**Every request to `/mcp` needs one of them, reads of public workflows included.** AI clients decide whether a server needs signing in when they first connect, so a server that answers anonymously never gets signed in to. Anyone can still read public workflows without an account on the website, through `GET /api/v1/...` and with `awml pull`. Decided 2026-10-22, over letting anonymous callers read public workflows through `/mcp`.

Every address the sign-in metadata gives comes from `BETTER_AUTH_URL`, so a self-hosted registry's `/mcp` works the same at its own address.

| Boundary | Test (`test/mcp.test.ts`) |
|---|---|
| Positive | A member publishes to and reads their organisation's private workflow through `/mcp`, and the audit log records both |
| Negative | A signed-out caller gets a 401 for every request; a non-member cannot read or publish a private workflow, which looks not found |
| Cross-tenant | Organisation A's token and OAuth session cannot list, get or publish organisation B's private workflows |
| Same access | A person's registry token and their OAuth token answer every tool the same |

## Not in v1

Comments and diffs between versions; live records and red lines sent in from running systems; SAML and Microsoft sign-in; teams inside an organisation; forks and stars; any AI feature of the registry's own; billing (hosted repo); the marketing pages (hosted repo). The MCP server came after v1 (above).
