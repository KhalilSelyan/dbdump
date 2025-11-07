#!/bin/bash

# Example: Dump complete schema from production for local cloning
# This creates a full SQL dump without needing a target database

bun run ../compareordumpdbs.ts \
  --source "postgresql://user:pass@prod.example.com:5432/myapp" \
  --generateFullMigrations \
  --output "production-dump" \
  --outputDir "./dumps"

echo "✅ Full schema dumped to: dumps/full-source/"
echo "💡 To recreate locally:"
echo "   createdb myapp_local"
echo "   cd dumps/full-source"
echo "   for f in *.sql; do psql myapp_local -f \$f; done"
