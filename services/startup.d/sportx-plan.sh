#!/bin/sh
set -eu
SITE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$SITE_ROOT"
umask 077
mkdir -p services/postgres/socket services/logs
exec 9>services/postgres/service.lock
flock -n 9 || exit 0
PG_BIN=${PG_BIN:-/usr/lib/postgresql/15/bin}
export PGHOST="$SITE_ROOT/services/postgres/socket" PGPORT=5544 PGUSER=codex PGDATABASE=sportx_plan
if [ ! -f services/postgres/data/PG_VERSION ]; then
 "$PG_BIN/initdb" -D services/postgres/data --username=codex --auth-local=peer --auth-host=reject --encoding=UTF8 --locale=C.UTF-8
 printf "\nlisten_addresses = ''\nport = 5544\nunix_socket_directories = '%s'\nunix_socket_permissions = 0700\n" "$PGHOST" >> services/postgres/data/postgresql.conf
fi
app_pid=''
stop() {
 trap '' TERM INT
 if [ -n "$app_pid" ]; then kill "$app_pid" 2>/dev/null || :; wait "$app_pid" 2>/dev/null || :; fi
 "$PG_BIN/pg_ctl" -D services/postgres/data -m fast -w stop || :
 exit 0
}
trap stop TERM INT
while :; do
 if ! "$PG_BIN/pg_ctl" -D services/postgres/data status >/dev/null 2>&1; then
  "$PG_BIN/pg_ctl" -D services/postgres/data -l services/logs/postgres.log -w start
 fi
 if ! "$PG_BIN/psql" -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='sportx_plan'" | grep -q 1; then
  "$PG_BIN/createdb" sportx_plan
 fi
 node services/server.js >> services/logs/api.log 2>&1 &
 app_pid=$!
 wait "$app_pid" || :
 app_pid=''
 sleep 2 &
 wait $! || :
done
