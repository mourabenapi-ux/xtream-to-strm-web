#!/bin/bash
# Migration script to add connection parameters to download_settings_global table
# This script applies the SQL migration to the SQLite database

set -e

DB_PATH="${DB_PATH:-/app/data/app.db}"
MIGRATION_FILE="/app/migrations/001_add_connection_params.sql"

echo "🔄 Applying migration: Add connection parameters..."
echo "Database: $DB_PATH"

# Check if database exists
if [ ! -f "$DB_PATH" ]; then
    echo "❌ Error: Database not found at $DB_PATH"
    exit 1
fi

# Apply migration
sqlite3 "$DB_PATH" < "$MIGRATION_FILE"

if [ $? -eq 0 ]; then
    echo "✅ Migration applied successfully!"
    echo ""
    echo "New columns added:"
    echo "  - max_redirects (INTEGER, default: 10)"
    echo "  - connection_timeout_seconds (INTEGER, default: 30)"
else
    echo "❌ Migration failed!"
    exit 1
fi
