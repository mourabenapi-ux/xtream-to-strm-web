#!/bin/bash
# Generic migration script to apply all SQL files in the migrations directory
# Usage: ./apply_migrations.sh [DB_PATH]

set -e

DB_PATH="${1:-${DB_PATH:-/app/data/app.db}}"
MIGRATIONS_DIR="$(dirname "$0")"

echo "🔄 Database Migration Utility"
echo "Database: $DB_PATH"

if [ ! -f "$DB_PATH" ]; then
    echo "❌ Error: Database not found at $DB_PATH"
    exit 1
fi

# Find all .sql files and apply them in order
for sql_file in $(ls "$MIGRATIONS_DIR"/*.sql | sort); do
    filename=$(basename "$sql_file")
    echo "🔹 Applying $filename..."
    
    # We use -bail to stop on first error
    # We wrap in a block to hide "table already exists" errors if we want, 
    # but better to let the user see them or use IF NOT EXISTS in SQL.
    sqlite3 "$DB_PATH" < "$sql_file"
    
    if [ $? -eq 0 ]; then
        echo "✅ $filename applied."
    else
        echo "❌ Error applying $filename"
        exit 1
    fi
done

echo "🎉 All migrations processed!"
