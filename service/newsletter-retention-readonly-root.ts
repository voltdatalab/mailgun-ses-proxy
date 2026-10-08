import type { HistoricalPreflightRoot } from './newsletter-retention-readonly-preflight.js'

/** Controlled out-of-band provisioning contract. An independently reviewed
 * application composition must return approved key/principal/procedure + exact
 * selected wave/schema/policy + observer-only collectors with bounded I/O.
 * No env key, JSON trust file, dynamic module path, default/generated principal,
 * request flag or archive/report-derived SQL schema can supply this root.
 * Not provisioned: never sign existing production evidence to make this green. */
export function getApprovedHistoricalReadOnlyPreflightRoot(): HistoricalPreflightRoot | undefined {
    return undefined
}
