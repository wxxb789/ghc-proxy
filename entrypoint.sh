#!/bin/sh

if [ "$#" -eq 0 ]; then
  set -- start
elif [ "$1" = "--auth" ]; then
  shift
  set -- auth "$@"
elif [ "${1#-}" != "$1" ]; then
  set -- start "$@"
fi

if [ "$1" = "start" ] && [ -n "${GH_TOKEN:-}" ]; then
  shift
  set -- start --github-token "$GH_TOKEN" "$@"
fi

exec bun ./dist/main.mjs "$@"
