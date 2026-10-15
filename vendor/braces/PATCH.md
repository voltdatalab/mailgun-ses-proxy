# Local security patch for braces 3.0.3

Upstream: https://github.com/micromatch/braces/tree/3.0.3 (MIT; LICENSE retained).
Advisory: https://github.com/advisories/GHSA-vfj7-8cjw-p6xm

As of 2026-10-15, upstream has no patched release. This source copy preserves
upstream package identity and API, adding a fixed nesting limit of 128 to both
parser stack pushes and the compile, expand and stringify AST walkers. Excessive
nesting raises a deliberate RangeError before recursive stack exhaustion. The
limit also applies to directly supplied ASTs and cannot be disabled by options.
Ordinary glob/range behavior remains unchanged; deeply nested patterns are no
longer accepted. This dependency is used by development glob/watch tooling.

Both npm and Bun override all braces consumers with this local package. Docker
copies it before installing dependencies. Local packages may not be evaluated
by npm audit: audit success is NOT proof of this patch. The regression suite in
`tests/security/braces-depth.test.ts` checks the original trigger, alternate
representations, direct ASTs and ordinary controls. Replace this override with
an audited upstream release when one becomes available.
