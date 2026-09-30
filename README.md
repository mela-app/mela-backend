# Mela backend

The Mela API: NestJS + TypeScript, Socket.IO, Prisma/PostgreSQL and Redis. It
serves the mobile app, the admin console, and the share pages (`/live/:id`)
that load the web player.

This repository also holds the local development stack
([docker-compose.yml](docker-compose.yml)) and the production one
([infra/production](infra/production)).

| Repository | What it is |
| --- | --- |
| **mela-backend** (this one) | The API, the dev stack, the production stack |
| mela-mobile | The Flutter app (viewers, hosts, guests) |
| mela-web | The web player that share links open in a browser |
| mela-admin-web | The staff admin console, plus the project docs (`docs/`) and the brand source (`branding/`) |

The documentation lives in **mela-admin-web**, under `docs/`: feature docs in
`docs/features/`, the server in `docs/deployment.md`. Code comments that
mention `docs/...` mean that folder.

## Settings (.env)

Every setting and secret lives in `.env` only - it's gitignored, and
`.env.example` is the template, filled in for this machine. Neither the API
nor `docker-compose.yml` has a built-in address, port or key: both refuse to
start while a required value is missing, and name it. Create it first:

```
cp .env.example .env        # Windows: copy .env.example .env
```

| Group | Variables | Notes |
| --- | --- | --- |
| API (required) | `PORT`, `CORS_ORIGIN`, `DATABASE_URL`, `REDIS_URL`, `APP_URL_SCHEME`, `ANDROID_APP_PACKAGE_NAME`, `S3_REGION` | Checked at boot (`src/common/config/env.validation.ts`) |
| Secrets | `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `LIVEKIT_API_SECRET`, `AGORA_APP_CERTIFICATE`, `S3_SECRET_ACCESS_KEY`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `SEED_ADMIN_PASSWORD` | The samples only work locally: in production the API refuses sample or short secrets |
| Video, storage, push, links | `VIDEO_PROVIDER`, `AGORA_*`, `LIVEKIT_*`, `S3_*`, `PUSH_PROVIDER`, `CHAT_LINK_DOMAINS`, `ANDROID_INSTALL_URL`, ... | Explained next to each one in `.env.example` |
| Dev scripts | `API_ORIGIN` | Where `scripts/*.js` reach this API |
| Docker | `POSTGRES_PASSWORD`, `BACKEND_PORT` | Read by `docker-compose.yml` |

The server has its own template, `infra/production/.env.example`.

## Getting started

With `.env` in place:

```
docker compose up -d        # Postgres, Redis, LiveKit, S3Mock
npm ci
npx prisma migrate dev
npm run db:seed
npm run start:dev
```

Health check: `GET http://localhost:<PORT>/health`.

`npm run db:seed` creates the first super admin for the admin console from
`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` (a one-time password: the console
asks for a new one at first sign-in). It is safe to run again.

Postgres runs **only in Docker** (PostgreSQL 16 on `localhost:5432`,
database `gambling_live`; a shell: `docker compose exec postgres psql -U
postgres -d gambling_live`). If PostgreSQL is also installed on this
machine, stop it: on Windows a local install silently takes IPv4 port 5432,
and the API ends up on the wrong database while Docker looks healthy. In an
admin PowerShell: `Stop-Service postgresql-x64-<version>; Set-Service
postgresql-x64-<version> -StartupType Disabled`, then `docker compose
restart postgres`.

Postgres, Redis and S3Mock listen on `127.0.0.1` only. LiveKit is used only
with `VIDEO_PROVIDER=livekit` (`docs/features/video-provider.md`); S3Mock
stands in for the avatar and chat-photo bucket (`docs/features/storage.md`).

## Everything in Docker

The API can run in a container too, from the image production uses:

```
docker compose --profile app up -d --build
```

A one-shot `migrate` container applies migrations and seeds the super
admin, then the API comes up on `http://localhost:<BACKEND_PORT>` (stop
`npm run start:dev` first, or pick another `BACKEND_PORT`). `docker compose
--profile app down` stops it again; the data stays in the Docker volumes.
The admin console and the web player run from their own repositories.

## Push notifications

Pushes need the Firebase service-account key at
`secrets/firebase-service-account.json` (gitignored) plus `PUSH_PROVIDER=fcm`
- see `docs/features/notifications.md`.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run start:dev` | API with hot reload on `PORT` |
| `npm run lint` | ESLint |
| `npx tsc --noEmit` | Type-check |
| `npm test` | Jest unit tests |
| `npx prisma migrate dev` | Apply migrations (and create one after a schema change) |
| `npm run db:seed` | Create the first super admin (`SEED_ADMIN_*`) |
| `node scripts/smoke-test-realtime.js` | Realtime smoke test against the API at `API_ORIGIN` |
| `node scripts/smoke-test-admin.js` | Admin API smoke test against the API at `API_ORIGIN` |
| `node scripts/livekit-fake-host.js` | A fake LiveKit host, to test the viewer side with one phone |

## Deploying

The API, the admin console, the web player, Postgres, Redis, Caddy (HTTPS)
and optionally LiveKit run on one server from
[infra/production](infra/production), in a clone of this repository - see
`docs/deployment.md`. The backend refuses to start in production with a
missing, sample or short secret.

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) lints, type-checks
and tests every push. CD ([.github/workflows/cd.yml](.github/workflows/cd.yml))
builds `ghcr.io/<owner>/mela-backend` on `main`, then, over SSH, applies the
migrations and restarts just the API. Its secrets (repository or
organization): `SERVER_HOST`, `SERVER_USER`, `SERVER_SSH_KEY` (or
`SERVER_PASSWORD`), `SERVER_SSH_FINGERPRINT`, `DEPLOY_PATH`.
