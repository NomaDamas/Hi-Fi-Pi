# Upstream synchronization

Hi-Fi Pi absorbs upstream Pi deliberately. The rehearsal automation reports changes and tests compatibility; it never merges, rebases, pushes, or rewrites a maintainer branch.

The reviewed upstream base is stored in `.github/upstream-baseline.json`. That commit is also recorded in every Hi-Fi SDK release manifest and included in the source archive.

## Refresh workflow

1. Configure the read-only upstream remote:

   ```bash
   npm run upstream:setup
   ```

   The command sets the fetch URL to `https://github.com/earendil-works/pi.git` and the push URL to the deliberately invalid value `DISABLED`.

2. Fetch upstream and generate the machine-readable delta report:

   ```bash
   npm run upstream:report -- --fetch
   ```

   The report is written to `.artifacts/upstream-delta.json`. It lists upstream commits and files since the reviewed base, flags changes to protected Hi-Fi integration surfaces, and records merge-rehearsal conflicts.

3. Create a review branch from the current Hi-Fi main branch and merge the reviewed upstream commit manually. Do not rebase a shared branch and do not force-push. Resolve each protected-surface conflict with the additive sidecar and legacy fast-path contracts in mind.

4. Validate the resolved branch:

   ```bash
   npm run build:offline
   npm run test:upstream-compat
   npm run check
   ./test.sh
   ```

   `test:upstream-compat` covers attachment-free provider payloads, event ordering and shapes, session compatibility, extension/package loading, and the native attachment contracts.

5. Only after the upstream commit is merged and all checks pass, update the reviewed base:

   ```bash
   npm run upstream:baseline -- --commit upstream/main
   ```

   The command refuses a commit that is not already an ancestor of `HEAD`. Commit the baseline update together with any reviewed conflict resolutions.

## CI rehearsal

The weekly and manually dispatchable `Upstream sync rehearsal` workflow fetches upstream without GitHub credentials, generates the delta report, builds the fork, runs compatibility contracts, and uploads the report. A rehearsal finding is review input; it does not change repository history.
