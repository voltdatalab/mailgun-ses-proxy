export function validateSafeRunnerMode({ multiUid, uid, githubActions, runnerEnvironment }) {
    if (multiUid && (uid !== 0 || githubActions !== 'true' || runnerEnvironment !== 'github-hosted')) throw new Error('multi-UID bootstrap is CI-only on ephemeral GitHub-hosted Linux runners as root')
    if (!multiUid && uid === 0) throw new Error('root requires explicit CI-only multi-UID mode')
    // Hosted mode uses the private-child direct-map bootstrap, not subuid helpers.
    return multiUid ? [] : ['--user', '--map-root-user']
}
