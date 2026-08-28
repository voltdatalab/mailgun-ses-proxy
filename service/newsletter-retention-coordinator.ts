import {
    buildNewsletterRetentionManifest,
    parseNewsletterRetentionEvidence,
    parseNewsletterRetentionPolicy,
    type NewsletterRetentionEvidenceInput,
    type NewsletterRetentionManifest,
    type NewsletterRetentionManifestInput,
    type NewsletterRetentionPolicy,
    type NewsletterRetentionPolicyInput,
} from '@/service/newsletter-retention'
import {
    buildNewsletterRetentionSelectionPlan,
    createProcessLocalAntiOverlapLock,
    withProcessLocalAntiOverlapLock,
    type NewsletterRetentionSelectionPlan,
    type NewsletterRetentionSelectionPlanCandidateInput,
} from '@/service/newsletter-retention-plan'

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

function normalizeDryRunPolicy(policy: NewsletterRetentionPolicyInput): NewsletterRetentionPolicy {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
        throw new Error('dry-run coordinator policy must be a plain object')
    }

    if ((policy as { apply?: unknown }).apply === true) {
        throw new Error('apply is not enabled')
    }

    return parseNewsletterRetentionPolicy(policy)
}
