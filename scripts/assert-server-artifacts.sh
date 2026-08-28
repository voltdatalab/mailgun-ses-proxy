#!/bin/sh
set -eu

for artifact in \
    dist/server.js \
    dist/scripts/reconcile-newsletter-orphan.js
do
    if [ ! -r "$artifact" ]; then
        printf '%s\n' 'required server artifact is missing' >&2
        exit 1
    fi
done
