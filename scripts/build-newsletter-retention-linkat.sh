#!/bin/sh
set -eu

output='dist/scripts/newsletter-retention-linkat'
source_file='scripts/newsletter-retention-linkat.c'

mkdir -p 'dist/scripts'

if [ -n "${NEWSLETTER_RETENTION_LINK_HELPER_PREBUILT:-}" ]; then
    if [ ! -x "$NEWSLETTER_RETENTION_LINK_HELPER_PREBUILT" ]; then
        printf '%s\n' 'prebuilt newsletter retention link helper is missing' >&2
        exit 1
    fi
    exit 0
fi

compiler="${CC:-cc}"
"$compiler" -std=c11 -O2 -Wall -Wextra -Werror "$source_file" -o "$output"
chmod 0755 "$output"
