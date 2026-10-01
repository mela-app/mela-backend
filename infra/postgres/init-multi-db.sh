#!/bin/bash
# Mela's lines for the shared Postgres init script
# (/usr/src/apps/infra/postgres/init-multi-db.sh). Add the three statements
# below to that file, next to the other apps' databases - this copy is only
# the record of what Mela needs.
#
# The init scripts run ONLY when Postgres initialises an empty data
# directory, so on a server that already has data, create the database by
# hand instead - see README.md next to this file.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    CREATE DATABASE mela_system;
    CREATE USER mela_system_user WITH PASSWORD 'change-me';
    GRANT ALL PRIVILEGES ON DATABASE mela_system TO mela_system_user;
EOSQL
