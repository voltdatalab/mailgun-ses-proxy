#!/bin/sh
set -eu

for artifact in \
    dist/server.js \
    dist/scripts/reconcile-newsletter-orphan.js \
    dist/scripts/newsletter-retention.js
do
    if [ ! -r "$artifact" ]; then
        printf '%s\n' 'required server artifact is missing' >&2
        exit 1
    fi
done

link_helper="${NEWSLETTER_RETENTION_LINK_HELPER_PREBUILT:-dist/scripts/newsletter-retention-linkat}"
if [ ! -x "$link_helper" ]; then
    printf '%s\n' 'required executable server artifact is missing' >&2
    exit 1
fi
