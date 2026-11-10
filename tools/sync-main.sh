#!/bin/sh
# Copies Deluxe Main's server code into this Worker, which keeps Deluxe Main's
# data (accounts, sign-ins, every website's saved data) at /main/api. Deluxe
# Main's pages are on Vercel. Deluxe-Main is the source; run this after
# changing it:   sh tools/sync-main.sh ../Deluxe-Main
set -e
SRC="${1:-../Deluxe-Main}"
here="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$here/worker/main"
cp "$SRC/worker/core.js" "$SRC/worker/apps.js" "$here/worker/main/"
echo "Copied Deluxe Main's server from $SRC"
