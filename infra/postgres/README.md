# Mela's database on the shared Postgres

Postgres is not Mela's: it runs once for every app, in
`/usr/src/apps/infra/postgres`, and Mela only needs a database and a user
of its own there. Nothing in this folder is deployed - it is the record of
what to add.

## A server that already has data

The init scripts in `/docker-entrypoint-initdb.d` run **only** when Postgres
starts on an empty data directory, so on a running server they are not an
option. Create the database by hand, once, from the Postgres container:

```
docker exec -it postgres psql -U "$POSTGRES_USER" -c "CREATE DATABASE mela_system;"
docker exec -it postgres psql -U "$POSTGRES_USER" -c "CREATE USER mela_system_user WITH PASSWORD '<password>';"
docker exec -it postgres psql -U "$POSTGRES_USER" -c "GRANT ALL PRIVILEGES ON DATABASE mela_system TO mela_system_user;"
docker exec -it postgres psql -U "$POSTGRES_USER" -d mela_system -c "GRANT ALL ON SCHEMA public TO mela_system_user;"
```

The last one matters on Postgres 15 and later: `GRANT ALL PRIVILEGES ON
DATABASE` no longer carries the right to create tables in `public`, and
without it the API's first migration fails with *permission denied for
schema public*.

Use the same password in `DATABASE_URL` and `POSTGRES_PASSWORD` in
`/usr/src/apps/mela/api/.env`.

## A server being set up from scratch

Add the statements in [`init-multi-db.sh`](init-multi-db.sh) to the shared
`/usr/src/apps/infra/postgres/init-multi-db.sh`, next to the other apps',
before Postgres starts for the first time. That script also has to be
mounted - the line is commented out in the shared compose file:

```yaml
volumes:
  - ./init-multi-db.sh:/docker-entrypoint-initdb.d/init-multi-db.sh:ro
```

## Backups

Mela's data lives here (avatars and chat photos are in the bucket). A
nightly dump, from the shared infra folder:

```
docker exec -t postgres pg_dump -U mela_system_user -d mela_system --format=custom > mela-$(date +%F).dump
```

Restore into an empty database with `pg_restore -U mela_system_user -d
mela_system --clean --if-exists`. Keep copies off the server. Redis holds
only rate limits, presence and queued jobs - persisted, but nothing that
needs backing up.
