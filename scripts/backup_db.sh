#!/bin/bash
# Daily backup: SQLite → GCS

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/retirement-calculator}"
GCS_BUCKET="${GCS_BUCKET:-gs://your-backup-bucket}"
KEEP_LOCAL=3

DATE=$(date +%Y-%m-%d)
BACKUP_DIR="$APP_DIR/backups"
BACKUP_FILE="$BACKUP_DIR/retirement-calculator-$DATE.db"
LOG="$BACKUP_DIR/backup.log"

mkdir -p "$BACKUP_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

log "Starting backup"

CONTAINER=$(docker-compose -f "$APP_DIR/docker-compose.yml" ps -q retirement-calculator-backend 2>/dev/null)
if [ -z "$CONTAINER" ]; then
  log "ERROR: retirement-calculator-backend container not running"
  exit 1
fi

docker exec "$CONTAINER" python3 -c "
import sqlite3, os
src = '/root/.retirement-calculator/retirement-calculator.db'
tmp = '/tmp/backup.db'
con = sqlite3.connect(src)
bak = sqlite3.connect(tmp)
con.backup(bak)
bak.close()
con.close()
print(f'backup ok, size={os.path.getsize(tmp)} bytes')
"

docker cp "$CONTAINER:/tmp/backup.db" "$BACKUP_FILE"
log "Copied to $BACKUP_FILE ($(du -sh "$BACKUP_FILE" | cut -f1))"

gsutil cp "$BACKUP_FILE" "$GCS_BUCKET/retirement-calculator-$DATE.db"
log "Uploaded to $GCS_BUCKET/retirement-calculator-$DATE.db"

ls -t "$BACKUP_DIR"/retirement-calculator-*.db 2>/dev/null | tail -n +$((KEEP_LOCAL + 1)) | xargs -r rm -f
log "Local copies pruned, keeping latest $KEEP_LOCAL"

log "Backup complete"
