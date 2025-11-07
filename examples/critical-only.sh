#!/bin/bash

# Example: Show only breaking changes before deploying
# Useful for pre-deployment checks

bun run ../compareordumpdbs.ts \
  --config ../db-config.json \
  --criticalOnly \
  --output "breaking-changes"

echo "✅ Critical changes only in: breaking-changes.md"
