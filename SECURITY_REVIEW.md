# Security and production-readiness review — 2026-09-19

Status: repository hardening completed; production deployment sign-off remains gated.
This review covers the checked-out source, dependency graph, tests and deployment contracts.
It is not a penetration test or a guarantee that every vulnerability has been eliminated.
No production deployment, provider consent, GitHub push or pull-request merge was performed.

## Steps and commits

| Step | Commit | Change and risk addressed |
| --- | --- | --- |
| 1 | `5a31001` | Replace JSON-based shell quoting in file, Git and review tools; refuse filesystem symlink traversal. Prevent command substitution through tool arguments and reads/writes outside the checkout through existing symlinks. |
| 2 | `427c7f0` | Add random OAuth state nonces, require cookie CSRF protection on auth routes even with a Bearer header, disable caching of API/auth/agent responses, and hide readiness database errors. |
| 3 | `e1fe932` | Parse GitHub repository hosts strictly, centralize credential URL construction, remove clone credentials from the agent checkout remote, and require the project owner's GitHub write permission before issuing App credentials. |
| 4 | `1431f8b` | Upgrade vulnerable direct/transitive esbuild versions to 0.25.12; make CI audit development/build dependencies as well as production dependencies. |
| 5 | `3b3738d` | Bound shell output and terminate descendant processes on timeout; limit WebSocket frames/backpressure; reject expired leases before reaping; protect development requests from hostile origins; rate-limit auth routes; bind development API to loopback; authorize production project creation. |
| 6 | `43295b4` | Remove raw provider failures from provisioning/startup errors so injected secrets and job tokens cannot be exposed through CLI arguments or provider request bodies. |
| 7 | `c1e350a` | Add a signed-in GitHub connection flow in Setup; update the WorkOS token endpoint; test session-bound identity, read-only access denial and grant revocation. |
| 8 | This document's commit | Record verification and remaining deployment gates; document the explicit development bind override. |

## Verification

- `DATABASE_URL='' pnpm verify`: passed. Includes deployment contracts, TypeScript,
  backend suites, local queue lifecycle, UI tests, and agent/API/web builds. Four
  PostgreSQL-only cases are explicitly skipped on PGlite.
- Subsequent targeted checks for the final changes passed: control plane **45**,
  agent lifecycle **17**, agent core **30**, GitHub authorization **4**, protocol **16**.
- `pnpm typecheck`: passed after the final integration changes.
- `pnpm test:ui`: **8 passed**; `DATABASE_URL='' pnpm test:e2e`: **3 Chromium tests passed**.
- `DATABASE_URL='' pnpm test:runtime`: compiled migration, API and worker checks passed
  again after the final code changes.
- `pnpm audit:all`: **no known vulnerabilities found** across the installed dependency graph.
- `pnpm release:preflight`: API, worker and web configuration passed. This validates
  configuration/executable presence, not live provider consent or application behavior.
- Real PostgreSQL control-plane suite: **42 passed** before the final additional local
  regressions. It used an isolated disposable schema, not the application's tables.
- Real PostgreSQL queue suite: **22 passed**, including all four PostgreSQL-only
  concurrency cases. The disposable test schema was cleaned up successfully.
- Tracked-file scan for common private-key/GitHub/OpenAI/AWS credential patterns: no matches.
  This is a limited pattern scan, not a complete secret-history audit.
- `git diff --check`: passed.

Docker and Azure CLI are unavailable on this machine, so image builds, image vulnerability
scanning, Bicep compilation and hosted CodeQL remain gates for this revision. Historical CI
results do not establish that the new revision passes those checks.

## Required deployment gates

1. Push the reviewed commits and run the current revision through hosted CI and CodeQL.
   Build both images, inspect their runtime users, scan the resulting OS/application layers,
   and compile the Azure Bicep templates. Run only the exact tested image revision.
2. Enable the GitHub provider in WorkOS Pipes. Each user must use **Setup → Connect GitHub**
   and grant access to the intended repositories. Install the GitHub App separately with
   Contents and Pull requests write permissions. An App installation alone no longer grants
   an arbitrary signed-in user repository access. Missing/revoked user access fails closed.
3. Verify WorkOS login, refresh and logout over the real HTTPS gateway; connect/revoke Codex;
   test GitHub consent, unauthorized repository denial, signed webhooks and a complete
   Captain → Build → PR/CI → Review lifecycle. Use `pnpm release:staging` and production smoke
   commands from `RELEASE.md`. These operations were not run against live accounts here.
4. Verify private database/API ingress and trusted proxy forwarding on the actual deployment.
   The limiter relies on the last forwarding hop; direct public access to the backend must
   not bypass that trust boundary. Configure edge connection/rate limits and service quotas.
5. Prove sandbox isolation and network egress policy for the selected VM provider. Production
   cannot use the local provider. Restrict metadata/private-network access as appropriate for
   the provider, enforce VM CPU/memory limits, and confirm teardown after failure/cancellation.
6. Perform an isolated restore and rollback rehearsal; configure alert delivery, metrics,
   provider spend limits, retention and encryption-key recovery. Attach dated evidence to
   `RELEASE.md` before declaring general availability.

## Behavior and limits

- Development binds to `127.0.0.1` by default. `CONTROL_PLANE_HOST` explicitly overrides
  this for trusted Docker/network setups. Production defaults to `0.0.0.0` behind ingress.
- Filesystem tools reject symlinks in requested paths, including legitimate symlinks.
  These checks are defense in depth; concurrent filesystem mutation and repository test
  scripts mean the VM remains the security boundary. A review role's tool restrictions do
  not make arbitrary repository test scripts safe or read-only at the OS level.
- Shell output retains at most 1 MiB per stream; timeout is exit code 124. A slow WebSocket
  client is disconnected and resumes through the existing cursor/replay protocol.
- GitHub authorization currently uses user-owned WorkOS Pipes connections. Organization-owned
  connection policy would require explicit authorization design before enabling it.
- App tokens already issued before a user loses access remain usable until their provider
  expiry; new credential requests are revalidated. Rotate/revoke exposed credentials through
  the provider if investigating a past incident.
- Provider failure details are deliberately omitted from application errors; use restricted
  provider diagnostics for troubleshooting. Do not reintroduce request bodies or CLI argv
  into customer-visible events or logs.

## References

The esbuild remediation follows the maintainer's
[GHSA-67mh-4wv8-2f99 advisory](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99).
The GitHub user-token request uses WorkOS's documented
[connected-account token endpoint](https://workos.com/docs/reference/pipes/access-token).
The authorization URL flow follows the official
[WorkOS Node SDK](https://github.com/workos/workos-node/blob/main/src/pipes/pipes.ts).
