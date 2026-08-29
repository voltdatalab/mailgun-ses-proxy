import {
    NEWSLETTER_RETENTION_ESCROW_VERSION,
    type NewsletterRetentionEscrowHeader,
    type NewsletterRetentionEscrowVerificationResult,
} from './newsletter-retention-escrow.js'
import {
    streamNewsletterRetentionEscrowRecords,
    type NewsletterRetentionEscrowLoaderDelegate,
} from './newsletter-retention-escrow-loader.js'
import { writeNewsletterRetentionEscrow } from './newsletter-retention-escrow-writer.js'
import type { NewsletterRetentionCandidateLoaderRecord } from './newsletter-retention-candidate-loader.js'
import {
    buildNewsletterRetentionManifest,
    parseNewsletterRetentionEvidence,
    parseNewsletterRetentionPolicy,
    type NewsletterRetentionEvidenceInput,
    type NewsletterRetentionManifest,
    type NewsletterRetentionManifestInput,
    type NewsletterRetentionPolicy,
    type NewsletterRetentionPolicyInput,
} from './newsletter-retention.js'
import {
    buildNewsletterRetentionSelectionPlan,
    createProcessLocalAntiOverlapLock,
    withProcessLocalAntiOverlapLock,
    type NewsletterRetentionSelectionPlan,
    type NewsletterRetentionSelectionPlanCandidateInput,
} from './newsletter-retention-plan.js'

export interface NewsletterRetentionDryRunCoordinatorInput {
    policy: NewsletterRetentionPolicyInput
    evidence: NewsletterRetentionEvidenceInput
    queueHealthy: boolean
    dlqHealthy: boolean
    candidates: NewsletterRetentionSelectionPlanCandidateInput[]
}

export interface NewsletterRetentionDryRunResult {
    dryRun: true
    policyVersion: NewsletterRetentionPolicy['policyVersion']
    plan: NewsletterRetentionSelectionPlan
    manifest: NewsletterRetentionManifest
}

export interface NewsletterRetentionEscrowDryRunCoordinatorInput {
    policy: NewsletterRetentionPolicyInput
    evidence: NewsletterRetentionEvidenceInput
    queueHealthy: boolean
    dlqHealthy: boolean
    candidates: NewsletterRetentionCandidateLoaderRecord[]
    delegate: NewsletterRetentionEscrowLoaderDelegate
    schemaFingerprint: string
    writeChunk(chunk: Uint8Array): void | Promise<void>
}

export interface NewsletterRetentionEscrowDryRunResult extends NewsletterRetentionDryRunResult {
    escrow: NewsletterRetentionEscrowVerificationResult
}

export async function buildNewsletterRetentionDryRunResult(
    input: NewsletterRetentionDryRunCoordinatorInput,
): Promise<NewsletterRetentionDryRunResult> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('dry-run coordinator input must be a plain object')
    }

    const policy = normalizeDryRunPolicy(input.policy)
    const evidence = parseNewsletterRetentionEvidence(input.evidence)

    const lock = createProcessLocalAntiOverlapLock(policy.siteId)

    return withProcessLocalAntiOverlapLock(lock, async () => {
        const plan = buildNewsletterRetentionSelectionPlan({
            policy,
            evidence,
            queueHealthy: input.queueHealthy,
            dlqHealthy: input.dlqHealthy,
            candidates: input.candidates,
        })

        const manifest = buildNewsletterRetentionManifest({
            siteId: policy.siteId,
            cutoff: plan.cutoff,
            policyVersion: policy.policyVersion,
            batches: plan.batches as unknown as NewsletterRetentionManifestInput['batches'],
        })

        return {
            dryRun: true,
            policyVersion: policy.policyVersion,
            plan,
            manifest,
        }
    })
}

export async function buildNewsletterRetentionEscrowDryRunResult(
    input: NewsletterRetentionEscrowDryRunCoordinatorInput,
): Promise<NewsletterRetentionEscrowDryRunResult> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('escrow dry-run coordinator input must be a plain object')
    }

    const policy = normalizeDryRunPolicy(input.policy)
    const evidence = parseNewsletterRetentionEvidence(input.evidence)
    const lock = createProcessLocalAntiOverlapLock(policy.siteId)

    return withProcessLocalAntiOverlapLock(lock, async () => {
        const plan = buildNewsletterRetentionSelectionPlan({
            policy,
            evidence,
            queueHealthy: input.queueHealthy,
            dlqHealthy: input.dlqHealthy,
            candidates: input.candidates,
        })
        const manifest = buildNewsletterRetentionManifest({
            siteId: policy.siteId,
            cutoff: plan.cutoff,
            policyVersion: policy.policyVersion,
            batches: plan.batches as unknown as NewsletterRetentionManifestInput['batches'],
        })
        const header: NewsletterRetentionEscrowHeader = {
            kind: 'header',
            version: NEWSLETTER_RETENTION_ESCROW_VERSION,
            siteId: policy.siteId,
            cutoff: policy.cutoff,
            policyVersion: policy.policyVersion,
            publicManifestHash: manifest.hash,
            schemaFingerprint: input.schemaFingerprint,
        }
        const escrow = await writeNewsletterRetentionEscrow({
            header,
            records: streamNewsletterRetentionEscrowRecords(input.delegate, policy, input.candidates),
            writeChunk: input.writeChunk,
        })

        assertEscrowMatchesPlan(escrow, plan, manifest)
        return {
            dryRun: true,
            policyVersion: policy.policyVersion,
            plan,
            manifest,
            escrow,
        }
    })
}

function assertEscrowMatchesPlan(
    escrow: NewsletterRetentionEscrowVerificationResult,
    plan: NewsletterRetentionSelectionPlan,
    manifest: NewsletterRetentionManifest,
): void {
    if (
        escrow.siteId !== plan.siteId
        || escrow.cutoff !== plan.cutoff
        || escrow.policyVersion !== manifest.policyVersion
        || escrow.publicManifestHash !== manifest.hash
        || escrow.counts.batches !== plan.batchCount
        || escrow.counts.messages !== plan.totals.messageCount
        || escrow.counts.errors !== plan.totals.errorCount
        || escrow.counts.notifications !== plan.totals.notificationCount
    ) {
        throw new Error('escrow commitment does not match the retention plan')
    }
}

function normalizeDryRunPolicy(policy: NewsletterRetentionPolicyInput): NewsletterRetentionPolicy {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
        throw new Error('dry-run coordinator policy must be a plain object')
    }

    if ((policy as { apply?: unknown }).apply === true) {
        throw new Error('apply is not enabled')
    }

    return parseNewsletterRetentionPolicy(policy)
}
