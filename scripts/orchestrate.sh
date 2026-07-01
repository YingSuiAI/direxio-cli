#!/usr/bin/env sh
set -eu

if [ "$#" -eq 0 ]; then
  exec direxio deploy
fi

exec direxio "$@"
