#!/bin/sh
# Copies Deluxe Main (accounts, sign-in and saved data) into this Worker, which
# is the one Deluxe server: it serves Deluxe Main at /main and Deluxe Drive's
# files at /api. Deluxe-Main is the source; run this after changing it:
#   sh tools/sync-main.sh ../Deluxe-Main
set -e
SRC="${1:-../Deluxe-Main}"
here="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$here/worker/main" "$here/main"
cp "$SRC/worker/core.js" "$SRC/worker/apps.js" "$here/worker/main/"
rm -rf "$here/main"/*
cp -R "$SRC/public/." "$here/main/"
echo "Copied Deluxe Main from $SRC"
