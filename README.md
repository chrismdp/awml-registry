# AWML Registry

You do not have to host a registry yourself. There is an official one at [awml.io](https://awml.io), free for public workflows.

The AWML Registry stores, versions and draws [AWML](https://github.com/chrismdp/awml) workflow files. You push a workflow's one AWML 0.6 file, which holds its design and any implementations, and the registry checks it, numbers each push as a new version, and draws its security view and the platform view of each implementation. Public workflows are open to anyone. You can keep private workflows on your own account, which only you see. An organisation can also keep private workflows, which only its members see, with an inventory of all its workflows and an audit log.

The registry also keeps platforms: descriptions of where a workflow can run, each with an optional install recipe. It works out which platforms a workflow fits, with the same AWML code as `awml fit`.

`docs/SPEC.md` says what v1 does and why.

## Run it on your machine

You need Node 22.

```sh
npm install
cp .env.example .env.local   # then set BETTER_AUTH_SECRET
npm run dev
```

The registry will not start without a `BETTER_AUTH_SECRET` of at least 32 random characters. `openssl rand -base64 32` makes one.

Open http://localhost:3000. The data goes in `data/registry.db`, made on first use.

To sign in, enter your email. Unless you set up email (see Settings), the registry prints the sign-in link in the terminal running `npm run dev`. Open it in your browser.

To push from the command line, make a token at `/settings/tokens`, then:

```sh
curl -X POST http://localhost:3000/api/v1/<you>/<workflow>/versions \
  -H "Authorization: Bearer <token>" -H "content-type: application/json" \
  -d '{"workflow": "<the YAML of the workflow file>"}'
```

To keep the workflow private, add `"visibility": "private"` to its first push, or push it with `awml push --private`. A private workflow on your own account is seen by you alone; anyone else gets a 404, as for one that doesn't exist. A later push cannot change it. The registry may limit how many private workflows one person keeps (see "Where to change things"); an organisation has no such limit.

The registry takes only AWML 0.6 files, marked `awml: "0.6"`. It refuses an older file with a 400 that says how to convert it: run `awml convert workflow.yaml > upgraded.yaml`, or for a 0.3 or 0.2 pair `awml convert security.yaml platform.yaml > upgraded.yaml`, and push that. Versions stored in an older AWML are never rewritten: the registry converts each one whenever it draws, checks or fits it, and its YAML tab and download give the file as it was pushed.

The workflow's page is then at `/<you>/<workflow>`. Each view has its own address: `/<you>/<workflow>/security`, which draws the design; `/platform`, which draws the first implementation, with each at `/platform/<implementation>`; `/yaml`, which shows the file as text to copy or download; and `/checks`, which says what checking the file found. Older versions are at `/<you>/<workflow>/v/<n>`, with their views at `/v/<n>/security` and so on. Versions pushed before the registry took only 0.4 files keep their security and platform files, and their pages still show them, converted: a platform file is drawn only when AWML can join it with its security file.

To show a public workflow's drawing on another site, put its `/embed` address in an iframe: `/<you>/<workflow>/embed` for the latest version, or `/<you>/<workflow>/v/<n>/embed` for one that won't change. A system's map is at `/<you>/systems/<system>/embed`. Add `?view=platform` (and `&implementation=<id>`) to draw where it runs, `?flow=1` to open it in Flow only, or `?physics=1` to open it in Physics. The embed shows only the drawing, with a link back to its page in the corner; every link opens a new tab.

```html
<iframe src="https://<registry>/<you>/<workflow>/v/<n>/embed" width="100%" height="480" style="border:0" loading="lazy" title="<the workflow's title>"></iframe>
```

Only public workflows and systems can be embedded: a private one is a 404, even to its owner. The embed addresses are the only pages another site may frame. Every other page, sign-in and settings included, refuses to be shown in another site's frame.

Run the tests with `npm test` and the type check with `npm run typecheck`.

## Platforms and where a workflow can run

A platform is described in AWML's platform description format (see "Placing a workflow: where it can run" in AWML's `SPEC.md`). Push one with its install recipe, the Markdown steps an agent follows to install a workflow there:

```sh
curl -X POST http://localhost:3000/api/v1/platforms/<you>/<platform>/versions \
  -H "Authorization: Bearer <token>" -H "content-type: application/json" \
  -d '{"description": "<the YAML of the description>", "recipe": "<Markdown steps>"}'
```

A recipe says where each secret goes, but never holds a secret itself. Anyone can read it, unless the platform is private. Only an organisation can keep a private platform: add `"visibility": "private"` to the first push.

Read the latest version at `GET /api/v1/platforms/<owner>/<platform>`, one version at `.../v/<n>`, and its files at `/<owner>/platforms/<platform>/v/<n>/description.yaml` and `.../recipe.md`. A platform's page is `/<owner>/platforms/<platform>`, the same as the reference AWML gives it; the old `/platforms/<owner>/<platform>` addresses redirect there.

On the site, `/<owner>/platforms` lists an owner's platforms with links to their files, and `/platforms` lists and searches every platform you can see.

To find where a workflow can run:

```sh
curl -X POST http://localhost:3000/api/v1/fit \
  -H "Authorization: Bearer <token>" -H "content-type: application/json" \
  -d '{"workflow": "<owner>/<workflow>", "platforms": ["<owner>/<platform>"]}'
```

Leave out `platforms` to fit against every platform you can see: the public ones, and your organisations' private ones. Send `"file": "<YAML>"` in place of `workflow` to fit a 0.6 file that is not in the registry. For each platform, the answer says whether the workflow's design fits, and if not, every reason. Add `"implementation": "<id>"` to judge where one implementation places each part instead, as `awml fit --implementation` does: each block is judged against the platform it names, found among those platforms by its description's id, or by the platform's address, as in `platform: acme/platforms/ops-runner`. A new registry has no platforms until someone pushes one.

A platform description must be marked `awml: "0.6"`. The registry refuses an older one with a 400 that says to convert it with `awml convert`; one stored before is converted whenever the fit reads it. A description may give its own address as its id, `platform: { id: <owner>/platforms/<slug>, ... }`, but never another platform's.

## Use the awml command

The `awml` command talks to awml.io unless you tell it otherwise. To use your own registry, set `AWML_REGISTRY_URL` to its address, or pass its address with `--registry`:

```sh
export AWML_REGISTRY_URL=http://localhost:3000
awml login    # asks for a token made at /settings/tokens
awml push <you>/<workflow> workflow.yaml
```

If the registry says the token is not valid, it was revoked or mistyped. Make a new one and run `awml login` again.

## Your username

Your username is the name in your page's address and in your workflows', `<registry>/<you>/<workflow>`. The registry makes one from your email address when you first sign in. To change it, use the Username field in Settings, ask your AI (the `set_username` tool), or send:

```sh
curl -X PATCH <registry>/api/v1/me \
  -H "Authorization: Bearer <token>" -H "content-type: application/json" \
  -d '{"username": "<new name>"}'
```

A username follows the same rules as an organisation's: lowercase letters, digits and single hyphens, not reserved, and not taken by a person or an organisation. Your workflows and platforms move with you. Links to your old name redirect to the new one, the API included, until someone else takes the old name. Each organisation you belong to records the change in its audit log.

## Connect your AI

Your registry is also an MCP server, at `/mcp` on its address. Below, `<registry>` is that address: the `BETTER_AUTH_URL` of your own registry, or `https://awml.io` for the official one. Every address the sign-in gives out comes from `BETTER_AUTH_URL` too.

Connect your AI to it and it can check, read and publish workflows as you, with the tools `check`, `publish`, `get`, `list` and `search`. It can find and add platforms with `search_platforms`, `get_platform` and `add_platform`, find where a workflow can run with `fit_workflow`, save a system of several workflows seen together with `publish_system`, and change your username with `set_username`. Then it can follow a platform's recipe to install the workflow there. `docs/SPEC.md` says what each tool does. It runs on your account, and the registry sends nothing to a model.

Every request to `/mcp` needs you signed in, so your AI asks you to sign in when you connect it. Public workflows stay readable without an account on the website, through the API and with `awml pull`.

**Claude.ai and Claude Desktop.** In Customize, open Connectors and add a custom connector with the URL `<registry>/mcp`. Claude reaches it from the internet, so it needs a public `https` address. Claude sends you to your registry to sign in, then asks you to allow it. Claude introduces itself with a client ID metadata document by default, and the registry accepts that or dynamic client registration, so there is nothing to choose. Your registry fetches that document from Claude's own address, so it needs to reach the internet. On a Team or Enterprise plan, an owner can add the connector for everyone in Organization settings, then each member connects it.

**ChatGPT.** Add a connector with the same URL. It signs in the same way.

**Claude Code.**

```sh
claude mcp add --transport http awml <registry>/mcp
```

Then run `/mcp` in Claude Code and choose awml to sign in.

**Codex**, with a token made at `/settings/tokens`:

```sh
codex mcp add awml --url <registry>/mcp --bearer-token-env-var AWML_TOKEN
export AWML_TOKEN=awml_...
```

That writes these lines to `~/.codex/config.toml`, which you can also write yourself:

```toml
[mcp_servers.awml]
url = "<registry>/mcp"
bearer_token_env_var = "AWML_TOKEN"
```

**Any other client** that takes a header: send `Authorization: Bearer <token>` with a token made at `/settings/tokens`.

**To see or cut off an AI app**, open Settings. Connected apps lists each app you have allowed, when you allowed it and when it last used your account, with a Disconnect button. A disconnected app cannot renew its access, so its access stops within an hour.

## Settings

| Variable | What it is |
|---|---|
| `BETTER_AUTH_URL` | The address people reach the registry at, exactly as the browser shows it, port included, such as `https://registry.example.com` or `http://localhost:8080`. If it is wrong, signing in fails with "Invalid origin" |
| `BETTER_AUTH_SECRET` | At least 32 random characters; `openssl rand -base64 32` makes one. The registry will not start without one |
| `DATABASE_PATH` | The SQLite file. Default: `data/registry.db` |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Optional. Sign-in with GitHub; the callback is `<BETTER_AUTH_URL>/api/auth/callback/github` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional. Sign-in with Google; the callback is `<BETTER_AUTH_URL>/api/auth/callback/google` |
| `MAIL_FROM` | Who sign-in emails come from, such as `Registry <login@example.com>`. Without it, no sign-in email is sent |
| `SMTP_URL` | An SMTP server to send sign-in emails through, such as `smtps://user:password@mail.example.com` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | The same as `SMTP_URL`, in parts. The port defaults to 587; port 465 uses TLS from the start |

Sign-in by email link always works. With `MAIL_FROM` and either `SMTP_URL` or `SMTP_HOST` set, the links are emailed. Without them, they are only written to the server's log, and the log says so each time, naming `MAIL_FROM` when that is what is missing. The sign-in page says so too.

## Host it yourself

The registry runs as one Docker container with its data in a SQLite file on a volume.

```sh
cp compose.example.yaml compose.yaml   # then set BETTER_AUTH_URL and BETTER_AUTH_SECRET
docker compose up -d
```

The container brings the database up to date each time it starts. `docker compose ps` shows it as healthy once it answers.

`BETTER_AUTH_URL` must match the address in the browser, port included. To serve on port 8080, change the port mapping to `"8080:3000"` and `BETTER_AUTH_URL` to `http://localhost:8080`. If you change one without the other, signing in fails with "Invalid origin".

Without email set up, the sign-in links are in the container's log:

```sh
docker compose logs registry | grep 'sign-in link'
```

**Backups.** SQLite runs in WAL mode here. It keeps recent changes in `registry.db-wal` until it folds them into `registry.db`, so a copy of `registry.db` alone can miss them. Stop the container first, or copy all three `registry.db*` files together:

```sh
docker compose stop registry
docker compose cp registry:/data ./registry-backup
docker compose start registry
```

## Run it on Cloudflare

The same app runs on Cloudflare Workers through the OpenNext adapter, with its data in D1. `wrangler.jsonc` binds a D1 database as `DB`. To try it locally:

```sh
npm run cf:migrate:local
printf 'BETTER_AUTH_SECRET=<32 random characters>\nBETTER_AUTH_URL=http://localhost:8787\n' > .dev.vars
npm run cf:build
npx wrangler dev --local-upstream localhost:8787 --upstream-protocol http
```

`npm run cf:build` swaps the SQLite file driver for the D1 one, so the Worker never carries the SQLite library. Once `wrangler.jsonc` has a route, `wrangler dev` makes each request look as if it came to the route's domain unless you pass `--local-upstream`, and signing in fails with "Invalid origin".

Locally, sign-in emails are written to `.wrangler/tmp/email/`, and the log says where.

On Cloudflare, sign-in emails go through Cloudflare Email Service. `wrangler.jsonc` binds it as `EMAIL` (`"send_email": [{ "name": "EMAIL" }]`). The sending domain must be onboarded in the Cloudflare account first, and sending to any address needs the Workers Paid plan. Without the binding, the Worker prints the links to its log.

### Deploy your own to Cloudflare

You need a Cloudflare account. Sign in to it with `npx wrangler login`, then:

1. Make the database. `npx wrangler d1 create awml-registry` makes it and prints its id; add `--jurisdiction eu` to keep the data in the EU.
2. Fill in the places in `wrangler.jsonc` marked "Yours:":
   - `database_id`: the id the last step printed.
   - `BETTER_AUTH_URL`: the address people reach the registry at. Without a route, that is the Worker's own address, `https://awml-registry.<your subdomain>.workers.dev`.
   - `MAIL_FROM`: who sign-in emails come from, at the domain you onboarded for sending, such as `Registry <login@registry.example.com>`.
   - `routes`, if you want: your own domain in place of `workers.dev`, on a zone in your Cloudflare account. The comment there shows one.
3. Set the secrets. Each command asks for the value, and offers to make the Worker the first time:

   ```sh
   npx wrangler secret put BETTER_AUTH_SECRET     # openssl rand -base64 32 makes one
   npx wrangler secret put GITHUB_CLIENT_ID       # optional, for signing in with GitHub
   npx wrangler secret put GITHUB_CLIENT_SECRET   # optional
   npx wrangler secret put GOOGLE_CLIENT_ID       # optional, for signing in with Google
   npx wrangler secret put GOOGLE_CLIENT_SECRET   # optional
   ```

   The GitHub and Google callbacks are `<BETTER_AUTH_URL>/api/auth/callback/github` and `<BETTER_AUTH_URL>/api/auth/callback/google`.
4. Deploy with `npm run cf:deploy`. It applies the database migrations to the D1 database, builds the Worker and deploys it. Run it again for each change.

## Where to change things

- `vendor/awml/` holds the AWML Go package compiled to WebAssembly, which checks, summarises, draws and fits each file, so the registry and the `awml` command line agree. `vendor/awml/VERSION` names the AWML commit. To move to a newer AWML, run `npm run engine:update -- /path/to/awml`; it needs Go, and rewrites the test fixtures with what the native `awml` prints so `npm test` compares the two.
- `src/edition.ts` decides whether an organisation may push and keep private workflows and platforms, how many private workflows a person may keep on their own account, what the home page shows, and whether the sign-in page links to terms and a privacy policy. The default allows everything, sets no limit, shows the gallery at `/` and links to neither.
- `drizzle/` holds the database migrations. After changing `src/db/schema.ts`, run `npm run db:generate`.
- `src/fonts/` holds Inter, the font AWML's drawings ask for, which the registry serves itself so drawings look the same in every browser.

## Licence

The registry is under the [Functional Source License, Version 1.1, MIT Future License](LICENSE) (FSL-1.1-MIT). You may use, change and run it for any purpose except offering it to others as a competing commercial product or service. Each version becomes MIT two years after its release. AWML itself, its spec, command line and Go package, is MIT.

The Inter font in `src/fonts/` is by The Inter Project Authors, under the SIL Open Font License 1.1, in `src/fonts/LICENSE.txt`.

The server lays out each drawing with elkjs 0.12.0, the Eclipse Layout Kernel for JavaScript, copyright Kiel University and others. The registry takes elkjs under the Eclipse Public License 2.0 (elkjs is offered under EPL-2.0 or GPL-3.0-or-later); its licence ships with it in `node_modules/elkjs/LICENSE.md`, and its source is at https://github.com/kieler/elkjs. The registry doesn't change elkjs, and it runs on the server only: no browser is sent it.
