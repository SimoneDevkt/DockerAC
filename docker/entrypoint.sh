#!/usr/bin/env bash
# DockerAC entrypoint
#  1. (as root) align the 'assetto' user with PUID/PGID, fix volume ownership, drop privileges
#  2. if Server Manager is not installed yet (or a reconfigure was requested) run the setup page
#  3. exec Server Manager (single or multiserver)
set -euo pipefail

DATA_DIR="${DATA_DIR:-/data}"
MARKER="$DATA_DIR/.installed"
RUN_USER=assetto

if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"
  [ "$(id -g "$RUN_USER")" = "$PGID" ] || groupmod -o -g "$PGID" "$RUN_USER"
  [ "$(id -u "$RUN_USER")" = "$PUID" ] || usermod -o -u "$PUID" "$RUN_USER"
  mkdir -p "$DATA_DIR"
  if [ "$(stat -c %u "$DATA_DIR")" != "$PUID" ] || [ "$(stat -c %g "$DATA_DIR")" != "$PGID" ]; then
    echo "[entrypoint] setting ownership of $DATA_DIR to $PUID:$PGID"
    chown -R "$PUID:$PGID" "$DATA_DIR"
  fi
  export HOME="/home/$RUN_USER"
  exec setpriv --reuid="$PUID" --regid="$PGID" --init-groups "$0" "$@"
fi

cd "$DATA_DIR"

# Manual install: binaries copied straight into the volume, no setup page needed.
# (.setup-tmp exists while a setup through the page is incomplete)
if [ ! -f "$MARKER" ] && [ -x "$DATA_DIR/server-manager" ] && [ ! -d "$DATA_DIR/.setup-tmp" ]; then
  if [ -f "$DATA_DIR/ACSM.License" ]; then variant=acsm; else variant=free; fi
  if [ -x "$DATA_DIR/assetto-multiserver-manager" ] && [ -f "$DATA_DIR/servers.yml" ]; then mode=multi; else mode=single; fi
  printf 'VARIANT=%s\nMODE=%s\nINSTALLED_AT=manual\n' "$variant" "$mode" > "$MARKER"
  echo "[entrypoint] found a manual install ($variant, $mode)"
fi

if [ ! -f "$MARKER" ] || [ -f "$DATA_DIR/.reconfigure" ] || [ "${SETUP:-0}" = "1" ]; then
  echo "[entrypoint] starting setup page"
  node /opt/setup/server.js
fi

MODE="$(sed -n 's/^MODE=//p' "$MARKER")"
if [ -n "${SM_MODE:-}" ]; then MODE="$SM_MODE"; fi

if [ "$MODE" = "multi" ]; then
  BIN=./assetto-multiserver-manager
else
  BIN=./server-manager
fi

echo "[entrypoint] starting $BIN"
exec "$BIN" "$@"
