#!/bin/bash

# Example: Basic database comparison
# This shows how to compare two databases and get a detailed report

bun run ../compareordumpdbs.ts \
  --source "postgresql://user:pass@localhost:5432/production" \
  --target "postgresql://user:pass@localhost:5432/staging" \
  --output "prod-vs-staging" \
  --skipSchemas "extensions" "graphql"

echo "✅ Report generated: prod-vs-staging.md"
echo "📁 Migrations in: diff-source-to-target/ and diff-target-to-source/"
