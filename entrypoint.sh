#!/bin/sh
if [ "$1" = "--auth" ]; then
  # Run auth command
  exec bun ./dist/main.mjs auth
else
  # Default command
  exec bun ./dist/main.mjs start -g "$GH_TOKEN" "$@"
fi
