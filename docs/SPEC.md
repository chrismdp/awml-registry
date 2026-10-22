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
| Platforms | A platform is an item of its own, apart from workflows, with an owner, a slug, a visibility and numbered versions that never change. Anyone signed in may publish a public platform, as with a workflow. Private platforms belong to organisations only. Decided 2026-10-22. |
| Install recipes | A recipe belongs to a platform version: optional Markdown pushed alongside the description. Recipes must not hold secrets. The registry does not scan them for secrets; it stores and serves them and never runs them. Decided 2026-10-22. |
| Pulling platforms | The API serves every platform version, so a command line can pull them. Pulling platforms with `awml` is a separate change to the CLI. Decided 2026-10-22. |
| Common platforms | Data, not code. This repo seeds no platforms, so a self-hosted registry starts with none, and nothing in the code knows which platforms are common. Tests use made-up platforms and AWML's example ones. Decided 2026-10-22. |
| The fit | Only the AWML engine judges where a workflow can run, the same Go package as `awml fit`, so the registry and the CLI give the same answer. Decided 2026-10-22. |
| Usernames | A person sets their own username, by the rules of an organisation's slug. Workflows and platforms are stored against the account, so they move with the name. A name given up redirects to the new one until a person or an organisation takes it (see "Usernames"). Decided 2026-10-22. |
| Drawings' font | AWML's drawings ask for Inter. The registry serves Inter itself, as a WOFF2 under the SIL Open Font License, so a drawing looks the same in every browser. Decided 2026-10-22. |

## What v1 does

- **Push and pull.** Push a workflow's security file, platform file or both from the CLI or the API. Every version can be downloaded as YAML or pulled with the CLI.
- **A page per version.** Both views drawn (Mermaid, drawn in the browser from the text the AWML package produces, in the Inter font the registry serves, loaded before Mermaid measures the labels), the check result, and the summary worked out from the files at push.
- **A public gallery.** Anyone can browse public workflows and search them by title. Anyone signed in can publish one, free.
- **Private workflows for an organisation.** Only its members can see them. In this repo's default edition every organisation may keep private workflows; the hosted edition limits that to paying organisations.
- **An inventory for each organisation.** Every workflow in one table with its summary counts, plus totals across them all.
- **An audit log for each organisation.** Who pushed, who viewed a private workflow or platform, who joined or left, and which member changed their username. Owners can read it; nobody can change it.
- **Platforms, and where a workflow can run.** Added after v1 (see "Platforms and the fit").

## Data

| Table | Holds |
|---|---|
| User, session, account, verification | Better Auth's own tables |
| Organisation | Slug, name, created at |
| Membership | A user in an organisation, as `owner` or `member` |
| Workflow | Owner (a user or an organisation, never both), slug, title, `public` or `private` |
| Version | Workflow, number, who pushed it and when, at most one security file and one platform file (YAML text), the check result, the summary as JSON |
| Platform | Owner (a user or an organisation, never both), slug, label (from the latest description), `public` or `private` |
| Platform version | Platform, number, who pushed it and when, the platform description (YAML text) and the install recipe (Markdown text), if any |
| Token | User, name, SHA-256 hash of the secret (the secret is shown once), created at, last used at |
| Audit event | Organisation, actor, action (`push`, `private_view`, `member_joined`, `member_left`, `member_renamed`), target, at. Rows are only ever added |
| Previous name | A username a person gave up, who gave it up and when. One row per name, the last person to give it up |
| OAuth clients, consents, access and refresh tokens, resources; JWKS | Better Auth's MCP plugin and JWT plugin keep these for AI clients signing in to `/mcp` |

User slugs and organisation slugs share one namespace. Reserved slugs that no user or organisation may take: `api`, `explore`, `gallery`, `settings`, `login`, `logout`, `signup`, `auth`, `new`, `admin`, `pricing`, `security`, `docs`, `about`, `blog`, `terms`, `privacy`, `help`, `status`, `_next`, `static`, `assets`, `mcp`, `consent`, `platforms`.

Platforms have a namespace of their own, under `/platforms` and `/api/v1/platforms`, so one owner may have a workflow and a platform with the same slug.

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
| `/settings` | Signing out, the username with Save, the AI apps connected to `/mcp` with a Disconnect for each, and the person's organisations |
| `/settings/tokens` | Make and revoke API tokens |
| `POST /api/v1/{owner}/{slug}/versions` | Push a version. Body JSON `{"security": "<yaml>"?, "platform": "<yaml>"?, "visibility": "public"\|"private"?}`, at least one file. The first push makes the workflow and sets its visibility (default public). Returns 201 with `{owner, slug, number, url}`, or 422 with `{errors: [...]}` |
| `GET /api/v1/{owner}/{slug}` | The workflow and its list of versions |
| `GET /api/v1/{owner}/{slug}/v/{n}` | One version's files, check result and summary |
| `POST /api/v1/platforms/{owner}/{slug}/versions` | Push a platform version. Body JSON `{"description": "<yaml>", "recipe": "<markdown>"?, "visibility": "public"\|"private"?}`. The first push makes the platform and sets its visibility (default public). Returns 201 with `{owner, slug, number, url}`, or 422 with `{errors: [...]}` |
| `GET /api/v1/platforms/{owner}/{slug}` | The platform's latest version: label, visibility, number, who pushed it and when, `description`, `recipe` (or null), and the list of versions |
| `GET /api/v1/platforms/{owner}/{slug}/v/{n}` | One platform version, the same way, without the list |
| `/platforms/{owner}/{slug}/v/{n}/description.yaml` | A platform version's description as YAML |
| `/platforms/{owner}/{slug}/v/{n}/recipe.md` | A platform version's install recipe as Markdown; 404 when it has none |
| `POST /api/v1/fit` | Where a workflow can run (see "Platforms and the fit") |
| `PATCH /api/v1/me` | Change the caller's own username. Body JSON `{"username": "<new name>"}`. Returns 200 with `{username, previous, url}`, 422 with `{errors: [...]}` for a name that is taken, reserved or badly formed, or 401 when nobody is signed in (see "Usernames") |
| `awml login` | Asks for a token made on the website, and saves it in `~/.config/awml/credentials`, readable only by its owner |
| `awml push owner/slug security.yaml platform.yaml [--private]` | Checks the files locally, then pushes them |
| `awml pull owner/slug[@n] [-o dir]` | Downloads the files of the latest version, or of version n |
| `/mcp` | The MCP server, streamable HTTP (see "The MCP server") |
| `/.well-known/oauth-protected-resource[/mcp]` | Where `/mcp` says its sign-in lives (RFC 9728) |
| `/.well-known/oauth-authorization-server[/api/auth]` | The sign-in server's metadata (RFC 8414): registration, authorisation and token endpoints under `/api/auth/oauth2/`, and `client_id_metadata_document_supported` |
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

Private platforms follow exactly these rules, through the same push rules (`src/server/push.ts`) and the same member check. Their tests are under "Private platforms" in `test/security.test.ts`:

| Boundary | Test |
|---|---|
| Positive | A member can read and push a private platform, and the audit log records the pushes and the views; a member's fit uses their organisation's private platforms, and records the view |
| Negative | A non-member and a signed-out visitor get 404 on a private platform's API, versions and files; a private platform answers exactly as a missing one does; a non-member cannot push to it |
| Cross-tenant | A token from a member of one organisation can neither read nor push another organisation's private platforms, nor push to its public ones; the fit never uses or reveals another organisation's private platform, in its results or its reasons, and naming one answers as a missing platform does |
| Roles | An owner and a member both push and read the organisation's private platforms, and a member who leaves cannot; the edition decides whether an organisation may push and keep private platforms |
| Invalid token | A revoked token gets the same 401 for a private, a public and a missing platform, on a push and on a fit |

## Usernames

Added on 2026-10-22. A person's username starts as the part of their email address before the `@`, made free at their first sign-in. They can change it on Settings, with `PATCH /api/v1/me` (a registry token or a browser session) and with the `set_username` tool on `/mcp`. Each acts only as the signed-in person and names no one else, so nobody can change another person's username. Better Auth's own update-user endpoint refuses a username.

**The rules** are an organisation's slug's: 1 to 40 lowercase letters, digits and single hyphens, starting and ending with a letter or digit, not reserved, and not held by a person or an organisation. A name is trimmed and lowercased first. The refusals say which rule: `Use 1 to 40 lowercase letters, digits and single hyphens, starting and ending with a letter or digit.`, `"settings" is reserved.` or `"bea" is taken.`

**What moves.** Workflows, platforms, versions and memberships are stored against the account, so they all appear under the new name at once, and the versions a person pushed show their new name. Each organisation the person belongs to records a `member_renamed` event, `olive to olive-new`, shown as "renamed" in its audit log.

**Old addresses.** A name a person gave up is kept in the previous names table. While no person or organisation holds it, every address under it answers with a 308 to the same address under the person's current name, query kept: the pages (`/{old}`, `/{old}/{slug}`, its versions, inventory and settings), the YAML and platform downloads, and every `/api/v1/{old}/...` and `/api/v1/platforms/{old}/...` route, pushes included. A 308 keeps the method and body, so a command line that follows redirects keeps reading and pushing. The redirect is the same whether anything is at the address or not, and the address it sends to makes its own access check, so it tells nobody anything about a workflow. After several renames, every old name leads to the current one.

**When the redirect stops.** An old name is free for anyone to take: a person renaming, someone signing up, or a new organisation. Once someone holds it, their page is there and the redirect stops. If a person takes the name and later gives it up, it redirects to them, as the last person to give it up. A person who takes back their own old name has their page there again, and the name they left redirects to it.

**`/mcp`** tools take names as they are now: an old name answers `Not found.`, as a missing owner does.

| Boundary | Test (`test/username.test.ts`) |
|---|---|
| Positive | A person changes their own username on Settings, through `PATCH /api/v1/me` with a token or a session, and through `set_username` with a registry token or an OAuth token; their workflows and platforms show under the new name; each of their organisations' audit logs records the rename, and no other organisation's |
| Negative | A taken, reserved or badly formed name is refused with a clear message on all three, and nothing changes; nobody can change another person's username, whatever the request names; a signed-out request gets a 401, and Settings sends them to sign in; a revoked or made-up token gets a 401 from the API and `/mcp` |
| Cross-tenant | Renaming moves only the person's own pages, never another person's or an organisation's; an old name now held by an organisation never redirects, and its private workflow is the same 404 to the name's former holder and to a stranger; a redirect sends a stranger to the new address, where a private workflow is still a 404 |
| Redirect lifecycle | The old name redirects with a 308 from pages, files and the API, keeping the query; after two renames both old names lead to the current one; the redirect stops once a person, someone signing up or an organisation takes the old name |

## The edition hook

`src/edition.ts` exports one object the hosted repo replaces with its own file. In v1 it carries:

- `canKeepPrivate(org): Promise<boolean>`: whether the organisation may push a private workflow or platform. Default: `true`.
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

**Tools.** Each calls the same functions in `src/server` as the website and the API, so it sees what the person may see and the audit log records the same events (`push` on publish and add_platform, `private_view` on reading a private workflow or platform, or fitting against a private platform, `member_renamed` on set_username).

| Tool | What it does |
|---|---|
| `check` | Checks a security file, a platform file or both with the AWML engine, and gives the mistakes. Saves nothing |
| `publish` | Saves a new version of `owner/slug`, by the same rules as `POST /api/v1/{owner}/{slug}/versions`. Gives the page `<registry>/{owner}/{slug}` and the version number |
| `get` | A workflow's YAML, check result and summary, the latest version or a given one |
| `list` | An owner's workflows the person may see; with no owner, their own and their organisations' |
| `search` | The public gallery by title |
| `search_platforms` | The platforms the person may see, public ones and their organisations' own, by words in the label or slug |
| `get_platform` | A platform's description and install recipe, the latest version or a given one |
| `add_platform` | Saves a new version of a platform, with its recipe, public or private, by the same rules as `POST /api/v1/platforms/{owner}/{slug}/versions` |
| `set_username` | Changes the person's own username, by the same rules as `PATCH /api/v1/me` (see "Usernames"). Gives the new name, the old one and their page |
| `fit_workflow` | Runs the fit for a workflow (`owner/slug`, with an optional `@version`, or its security view as YAML) against the platforms named, or every platform the person may see. Gives the same answer as `POST /api/v1/fit` |

The person's own AI reads a platform's recipe and does the installing. The registry neither runs a recipe nor sends anything to a model, and the fit is code.

**Signing in, two ways, both the same person.**

- OAuth 2.1 through Better Auth's MCP plugin (`@better-auth/mcp`). The client names itself by the https address of its client ID metadata document (CIMD, Better Auth's `@better-auth/cimd` with the MCP 2026-07-28 profile), as Claude.ai's custom connectors do by default, or registers itself with dynamic client registration. The sign-in server's metadata offers both. An AI client finds it from the address alone: `/mcp` answers a request without a token with a 401 whose `WWW-Authenticate` names the protected resource metadata, which names the sign-in server. The person signs in on `/login` as usual and allows the client on `/consent`. The access token is a JWT for `/mcp` only.
- `Authorization: Bearer <registry token>`, a token from `/settings/tokens`, for clients that take a header.

**Every request to `/mcp` needs one of them, reads of public workflows included.** AI clients decide whether a server needs signing in when they first connect, so a server that answers anonymously never gets signed in to. Anyone can still read public workflows without an account on the website, through `GET /api/v1/...` and with `awml pull`. Decided 2026-10-22, over letting anonymous callers read public workflows through `/mcp`.

Every address the sign-in metadata gives comes from `BETTER_AUTH_URL`, so a self-hosted registry's `/mcp` works the same at its own address.

**Fetching a client's metadata document** reaches only public addresses. Better Auth refuses a `client_id` whose host is a private, loopback, link-local or reserved address, gives up after five seconds and reads at most 5 KB; `src/server/client-metadata.ts` stops waiting at the five seconds even while a name is still being resolved. Under it, in Node (the Docker image), Better Auth's own transport resolves the name once, refuses unless every address is public, connects to that address only and never follows a redirect. On a Worker, which cannot choose the address it connects to, the name is resolved first over DNS over HTTPS and fetched only when every A and AAAA answer is public, without following a redirect. The tests are in `test/client-metadata.test.ts`. Added on 2026-10-22, after Claude.ai's custom connectors defaulted to CIMD and a person had to choose dynamic registration by hand.

| Boundary | Test (`test/mcp.test.ts`) |
|---|---|
| Positive | A member publishes to and reads their organisation's private workflow through `/mcp`, and the audit log records both |
| Negative | A signed-out caller gets a 401 for every request; a non-member cannot read or publish a private workflow, which looks not found |
| Cross-tenant | Organisation A's token and OAuth session cannot list, get or publish organisation B's private workflows |
| Same access | A person's registry token and their OAuth token answer every tool the same |

The platform tools have the same four, under "platforms through /mcp" in `test/mcp.test.ts`: a member adds and reads their organisation's private platform, and the audit log records both; a non-member cannot find, read, add to or fit against a private platform, which looks not found; organisation A's token and OAuth session cannot search, get, add to or fit against organisation B's private platforms; and a person's registry token and OAuth token answer every platform tool the same.

**Connected apps.** Settings lists each AI app the person has allowed on `/consent`: its name, when they allowed it and when it last used their account. That is when it last renewed its access, from the newest refresh token it holds for them, since `/mcp` checks an access token without the database and records nothing. Disconnect deletes the person's consent and every refresh and access token the app holds for them, and nobody else's, so it cannot renew. The access token it already holds is a JWT that lasts an hour, so access stops within an hour, as the page says. An app acts as one person, so organisation roles play no part. Added on 2026-10-22.

| Boundary | Test (`test/connected-apps.test.ts`) |
|---|---|
| Positive | A person disconnects their own app: it leaves the list, a refresh fails at once and `/mcp` refuses it once its hour is up |
| Negative | A person cannot see another person's app, and a Disconnect forged for it changes nothing |
| Cross-tenant | Disconnecting an app for one person leaves another person's access through the same app |
| Registry tokens | Disconnecting an app leaves the person's registry token working, and revoking a registry token leaves the app connected |

## Platforms and the fit

Added after v1, on 2026-10-22, for AWML 0.3, whose spec says where a workflow can run (its section "Placing a workflow: where it can run"). A workflow's security view says what it needs: who may process each scope (`processing`), how long work may wait after each trigger (`wait`) and where each existing context is kept (`at`). A **platform description** says what one platform offers: how long it may be off, whether the workflow's own code carries out its steps or an agent does, whose agents run there, which models its code can call and which folders it holds. The fit matches the two.

**A platform** is an item of its own: an owner, a slug, a visibility and numbered versions that never change, the same as a workflow. Each version holds:

- **the description**, AWML's platform description as YAML. It is checked at upload by the AWML engine and refused with `awml check`'s messages, each starting `description: `. A workflow's view sent as a description is refused, and so is a description sent as a workflow's file. The platform's label is the one its latest description gives.
- **an install recipe**, optional: Markdown steps an agent follows to install a workflow on that platform. It says what to create, where each secret goes, how to schedule the triggers and how to check the workflow is running. It never holds a secret itself. The registry stores and serves recipes, and never runs them.

**The fit.** `POST /api/v1/fit` takes a JSON body:

- `workflow`: `owner/slug` or `owner/slug@n`, a stored workflow whose version has a security view; or `security`: a security view as YAML. One of the two, not both.
- `platforms`: optional, a list of `owner/slug` or `owner/slug@n`. Without it, the fit runs against every platform the caller may see: the public ones, and the private ones of the organisations they belong to. Each platform named must be one the caller may read; a private platform of another organisation answers `404 Not found: owner/slug.`, exactly as a missing one does.

It answers 200 with `{workflow, results, gaps}`. `workflow` is `{owner, slug, number}`, or null for YAML. Each result is what `awml fit --json` gives for that platform, `{judged, fits, reasons, models}`, with `platform` as the registry address `owner/slug`, plus the version `number` and the description's `id` and `label`. When the workflow doesn't say what the fit needs, such as a scope without `processing` or a trigger without `wait`, `gaps` lists them and there are no results. The API answers anyone, signed in or not, as it does for reading; a token that is not valid gets the 401.

The registry gives the engine one platform at a time, so no platform's description reaches another's answer, and two platforms whose descriptions share an id are both judged. Each private platform judged is recorded in its organisation's audit log as a view.

This repo seeds no platforms. AWML's example platforms are in `test/fixtures/platforms`, copied by `npm run engine:update` with what the native `awml fit --json` says of them, so the tests compare the registry's fit with the CLI's.

Not yet: judging a placement drawn in a platform view whose blocks name their descriptions; pages for platforms and for where a workflow can run; pulling platforms with `awml pull`.

## Not in v1

Comments and diffs between versions; live records and red lines sent in from running systems; SAML and Microsoft sign-in; teams inside an organisation; forks and stars; any AI feature of the registry's own; billing (hosted repo); the marketing pages (hosted repo). The MCP server, platforms and the fit came after v1 (above).
