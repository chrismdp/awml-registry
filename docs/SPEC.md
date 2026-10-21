# AWML Registry: v1 spec

The AWML Registry stores, versions and draws AWML workflow files. Public workflows are free, and a private store for an organisation is paid on the hosted service. The code in this repo is source-available under FSL-1.1-MIT: a company may run it internally, but nobody may offer it as a competing service.

The source of truth for the decisions is the Claude Doc "AWML Registry spec" (https://claude.ai/artifact/BawGPKnfGE2kotu8TCm1Ht). This file is the build copy, revised on 2026-10-21 after Chris's comments on it. AWML itself (spec, CLI, Go package) is MIT at github.com/chrismdp/awml; read its `SPEC.md` for what a workflow file is.

## Decisions

| Decision | Choice |
|---|---|
| Code and licence | This repo, chrismdp/awml-registry, under FSL-1.1-MIT. The AWML spec and CLI stay MIT. |
| Editions | This repo is the whole self-hostable registry and contains **no billing code**. The hosted service at awml.io is a separate private repo that adds Stripe billing, the marketing pages and the Cloudflare deploy settings. This repo exposes an `edition` hook the hosted repo replaces; the default edition allows everything. |
| Address | One domain, awml.io. The registry is served from the root, so a workflow lives at `awml.io/{owner}/{slug}`. The marketing pages belong to the hosted repo, not this one. |
| Stack | Next.js (App Router, React, TypeScript) with Drizzle ORM over SQLite. |
| Hosting | Hosted: Cloudflare Workers through the OpenNext Cloudflare adapter, data in D1. Self-hosted: the same app as a Docker container, data in a SQLite file. |
| Sign-in | GitHub, Google, and a passwordless link by email. Through Better Auth, which keeps its tables in the same database. SAML single sign-on later through Better Auth's SSO plugin. |
| Workflow checks | Uploads are checked by the AWML Go package itself, compiled to WebAssembly, so the registry and the CLI give the same verdict. |
| Files with mistakes | Refused at upload, with the messages `awml check` gives. |
| Versions | Each push is a new numbered version, 1, 2, 3, never changed afterwards. |
| AI on customer content | None: the registry never sends a workflow to a model. Customers bring their own AI later through an MCP server (not v1). |

## What v1 does

- **Push and pull.** Push a workflow's security file, platform file or both from the CLI or the API. Every version can be downloaded as YAML or pulled with the CLI.
- **A page per version.** Both views drawn (Mermaid, drawn in the browser from the text the AWML package produces), the check result, and the summary worked out from the files at push.
- **A public gallery.** Anyone can browse public workflows and search them by title. Anyone signed in can publish one, free.
- **Private workflows for an organisation.** Only its members can see them. In this repo's default edition every organisation may keep private workflows; the hosted edition limits that to paying organisations.
- **An inventory for each organisation.** Every workflow in one table with its summary counts, plus totals across them all. This is the page a CIO or COO buys.
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

User slugs and organisation slugs share one namespace. Reserved slugs that no user or organisation may take: `api`, `explore`, `settings`, `login`, `logout`, `signup`, `auth`, `new`, `admin`, `pricing`, `security`, `docs`, `about`, `blog`, `terms`, `privacy`, `help`, `status`, `_next`, `static`, `assets`.

## Pages, API and CLI

| Route or command | What it does |
|---|---|
| `/` | In this repo: the gallery. The hosted edition puts its home page here |
| `/explore` | The gallery of public workflows, newest first, with search by title |
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

The API takes `Authorization: Bearer <token>` or a browser session. The CLI talks to `https://awml.io` unless `--registry` or `AWML_REGISTRY` names another.

## Access

A private workflow is visible to its organisation's members and to nobody else.

- **Public workflows** can be read by anyone, signed in or not. Only their owner can push to them: the user, or the organisation's members.
- **Private workflows** can be read only by members. Anyone else gets a 404, the same as for a workflow that doesn't exist, so a private workflow's name never leaks.
- **Owners** manage members. **Members** read and push. A token acts as its user and can do nothing more.
- A user's own workflows (owner is a user) are public only in v1; private workflows belong to organisations.

Each boundary has a test:

| Boundary | Test |
|---|---|
| Positive | A member can read and push a private workflow |
| Negative | A non-member and a signed-out visitor both get 404 on a private workflow, its files, its version pages and its API |
| Cross-tenant | A token from a member of organisation A can neither read nor push organisation B's workflows, public pushes included |
| Roles | An owner can do everything a member can, and manage members. A member cannot manage members or read the audit log |

## The edition hook

`src/edition.ts` exports one object the hosted repo replaces with its own file. In v1 it carries:

- `canKeepPrivate(org): Promise<boolean>`: whether the organisation may push a private workflow. Default: `true`.
- `canPush(org): Promise<boolean>`: whether the organisation may push at all (the hosted edition says no after a lapsed payment; reading stays allowed). Default: `true`.
- `homePage`: optional React component for `/`. Default: the gallery.

Nothing else in this repo knows that billing exists.

## Not in v1

Comments and diffs between versions; live records and red lines sent in from running systems; SAML and Microsoft sign-in; teams inside an organisation; forks and stars; any AI feature; the MCP server; billing (hosted repo); the marketing pages (hosted repo, built with Chris).
