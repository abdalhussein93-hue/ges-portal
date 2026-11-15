#!/bin/sh
# Nightly full backup of the portal database (all apps, users, history, snapshots).
# Runs inside the "backup" container. Files: ./backups/portal_YYYY-MM-DD_HHMM.dump
# Restore:  pg_restore --clean --if-exists -h db -U portal -d portal /backups/<file>.dump
set -eu

KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
mkdir -p /backups

backup() {
  stamp=$(date +%Y-%m-%d_%H%M)
  target="/backups/portal_${stamp}.dump"
  if pg_dump --format=custom --file="${target}.partial"; then
    mv "${target}.partial" "${target}"
    echo "$(date -Iseconds) backup written: ${target} ($(du -h "${target}" | cut -f1))"
  else
    rm -f "${target}.partial"
    echo "$(date -Iseconds) BACKUP FAILED" >&2
  fi
  find /backups -name 'portal_*.dump' -type f -mtime +"${KEEP_DAYS}" -delete
}

# first backup shortly after start, then every 24 hours
sleep 60
while true; do
  backup
  sleep 86400
done
