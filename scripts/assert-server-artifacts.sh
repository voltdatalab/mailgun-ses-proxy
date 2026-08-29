#!/bin/sh
set -eu

for artifact in \
    dist/server.js \
    dist/server.cjs \
    dist/scripts/reconcile-newsletter-orphan.js \
    dist/scripts/newsletter-retention.js
do
    if [ ! -r "$artifact" ]; then
        printf '%s\n' 'required server artifact is missing' >&2
        exit 1
    fi
done

if ! node --check dist/server.cjs >/dev/null; then
    printf '%s\n' 'compiled Node server entrypoint is invalid' >&2
    exit 1
fi

link_helper="${NEWSLETTER_RETENTION_LINK_HELPER_PREBUILT:-dist/scripts/newsletter-retention-linkat}"
if [ ! -x "$link_helper" ]; then
    printf '%s\n' 'required executable server artifact is missing' >&2
    exit 1
fi
