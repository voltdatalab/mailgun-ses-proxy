# Newsletter retention runner

The newsletter retention command is an explicit, operator-invoked Linux command. It has no startup hook or scheduler, defaults to dry-run, and shares the same MariaDB named lock between dry-run and apply.

## Output publication

Dry-run outputs use fail-closed, non-overwriting publication:

1. The command opens and validates every parent directory through pinned file descriptors.
2. It creates an unnamed inode in the destination filesystem with Linux `O_TMPFILE`.
3. It writes and fsyncs the complete JSON, applies the final mode, and fsyncs again.
4. A small native helper publishes that exact inode with `linkat(AT_SYMLINK_FOLLOW)` through inherited source and parent descriptors. Hard-link publication cannot overwrite an existing name.
5. The parent directory is fsynced before success is returned.

A failure before publication closes the anonymous descriptor, so no partial pathname or sensitive temporary file remains. The production image builds the static helper in an isolated Alpine stage and installs it root-owned at `/usr/local/libexec/newsletter-retention-linkat`; production does not fall back to a shell command.

The destination filesystem must support `O_TMPFILE`. The writable OverlayFS layer of a container, especially on the production Linux 5.15 host, must not be assumed to support it. Before promotion, provision and probe a dedicated bind mount or volume backed by a compatible filesystem for retention evidence. For the production image, attach the named volume at `/app/retention`: the image creates that directory as `node:node` before switching users, so Docker can initialize an empty volume with a secure, writable parent. Lack of support aborts with a sanitized error and must not be bypassed with a named temporary file.

An existing output is accepted only as an idempotent retry when its regular-file type, owner, link count, exact mode, byte length, and complete byte content all match. Different or unsafe content aborts and is never overwritten or deleted.

When both outputs are requested, the private artifact is published first with mode `0600`, followed by the public manifest with mode `0644`. A retry after a transient second-output failure reuses the first file only if it is exactly identical.

## Apply boundary

Publishing a manifest or private artifact does not authorize apply. Apply still requires explicit `--apply`, tenant confirmation, both expected hashes, fresh health/DLQ evidence, successful lock acquisition, and all Serializable transaction revalidations. Deployment, migration, scheduling, and production deletion require separate operational authorization.
