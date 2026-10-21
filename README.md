# AWML Registry

The AWML Registry stores, versions and draws [AWML](https://github.com/chrismdp/awml) workflow files. You push a workflow's security file, platform file or both, and the registry checks them, numbers each push as a new version, and draws both views. Public workflows are open to anyone. An organisation can also keep private workflows, which only its members see, with an inventory of all its workflows and an audit log.

`docs/SPEC.md` says what v1 does and why.

## Run it on your machine

You need Node 22.

```sh
npm install
cp .env.example .env.local   # then set BETTER_AUTH_SECRET
npm run dev
```

Open http://localhost:3000. The data goes in `data/registry.db`, made on first use.

To sign in, enter your email. Without an email provider, the registry prints the sign-in link in the terminal running `npm run dev`; open it in your browser.

To push from the command line, make a token at `/settings/tokens`, then:

```sh
curl -X POST http://localhost:3000/api/v1/<you>/<workflow>/versions \
  -H "Authorization: Bearer <token>" -H "content-type: application/json" \
  -d '{"security": "<the YAML of the security file>"}'
```

Run the tests with `npm test` and the type check with `npm run typecheck`.

## Settings

| Variable | What it is |
|---|---|
| `BETTER_AUTH_URL` | The address people reach the registry at, such as `https://registry.example.com` |
| `BETTER_AUTH_SECRET` | At least 32 random characters; `openssl rand -base64 32` makes one |
| `DATABASE_PATH` | The SQLite file. Default: `data/registry.db` |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Optional. Sign-in with GitHub; the callback is `<BETTER_AUTH_URL>/api/auth/callback/github` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional. Sign-in with Google; the callback is `<BETTER_AUTH_URL>/api/auth/callback/google` |

Sign-in by email link always works. Sending real email is not built yet: the link is written to the server's log.

## Host it yourself

The registry runs as one Docker container with its data in a SQLite file on a volume.

```sh
cp compose.example.yaml compose.yaml   # then set BETTER_AUTH_URL and BETTER_AUTH_SECRET
docker compose up -d
```

The container brings the database up to date each time it starts. Back up the volume to back up the registry.

## Run it on Cloudflare

The same app runs on Cloudflare Workers through the OpenNext adapter, with its data in D1. `wrangler.jsonc` binds a D1 database as `DB`. To try it locally:

```sh
npm run cf:migrate:local
echo 'BETTER_AUTH_SECRET=<32 random characters>' > .dev.vars
npm run cf:build
npx wrangler dev
```

`npm run cf:build` swaps the SQLite file driver for the D1 one, so the Worker never carries the SQLite library.

## Where to change things

- `vendor/awml/` holds the AWML Go package compiled to WebAssembly, which checks, summarises and draws each file, so the registry and the `awml` command line agree. `vendor/awml/VERSION` names the AWML commit. To move to a newer AWML, run `npm run engine:update -- /path/to/awml`; it needs Go, and rewrites the test fixtures with what the native `awml` prints so `npm test` compares the two.
- `src/edition.ts` decides whether an organisation may push and keep private workflows, and what the home page shows. The default allows everything.
- `drizzle/` holds the database migrations. After changing `src/db/schema.ts`, run `npm run db:generate`.

## Licence

The registry is under the [Functional Source License, Version 1.1, MIT Future License](LICENSE) (FSL-1.1-MIT). You may use, change and run it for any purpose except offering it to others as a competing commercial product or service. Each version becomes MIT two years after its release. AWML itself, its spec, command line and Go package, is MIT.
