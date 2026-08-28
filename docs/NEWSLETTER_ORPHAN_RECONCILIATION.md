# Newsletter orphan reconciliation

The standard CapRover application image contains the reconciliation command. There is no separate reconciliation image, startup hook, scheduler, or automatic scan.

## Safety contract

- Reconciliation is explicit and bounded to one opaque `notificationId`.
- It must be run only after an operator has verified that the parent newsletter message exists.
- The notification upsert and `reconciledAt` update run in one database transaction.
- The orphan ledger row is never deleted.
- Re-running an already reconciled ID returns `already_reconciled` without writing.
- The command prints only the sanitized result and never prints the identifier or payload.

## Build verification

`npm run build` and `bun run build` fail unless both runtime artifacts exist:

- `dist/server.js`
- `dist/scripts/reconcile-newsletter-orphan.js`

The CapRover `captain-definition` uses the standard `dockerfile`, so the verified reconciler artifact is shipped in the same image as the application.

## Authorized operation

From an explicitly approved shell inside the deployed application image:

```sh
RECONCILE_ORPHAN_NOTIFICATION_ID='<opaque-id>' bun run reconcile:newsletter-orphan
```

Do not place the ID in shared logs, a scheduler, image configuration, or committed files. Running the command is a production database mutation and requires separate authorization, health checks, and readback evidence.
