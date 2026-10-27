# Releasing import-sync

Development and release tooling requires Node.js 22.18+; release CI uses Node 24.
Install the project's pnpm dependencies before running the release scripts.
The scripts use installed tools and do not download missing tooling.
Registry and release commands also need npm. The tooling job uses `actions/setup-node`
to install Node and npm together; pnpm-managed Node runtimes omit npm. The scripts
prefer bundled npm and can locate a separate installation through its canonical
CLI, without executing shell wrappers or searching relative PATH entries.

## One-time npm configuration

Configure an npm trusted publisher for **import-sync** with GitHub owner
`nktnet1`, repository `import-sync`, workflow filename **`publish.yaml`**, and
environment **`Production`**. Allow direct `npm publish`. Create the matching
GitHub environment. Publishing uses OIDC with `id-token: write`, so no npm token
is needed in GitHub secrets.

Merge these workflows and scripts into the default branch before pushing a
release tag. Protect `main` and `v*` tags so only maintainers can release.

CI uses `pnpm install --frozen-lockfile --ignore-scripts` for dependency
installation. Refresh and commit `pnpm-lock.yaml` whenever dependencies or the
pinned pnpm version change; CI rejects an outdated lockfile. Installation hooks,
including the root `prepare` hook, are disabled in CI. The native-import fixture
uses node-datachannel's prebuilt platform packages.

## Beta releases

From a clean checkout, preview the next beta with
`pnpm release:beta --base 2.2.7 --dry-run`. Choose the intended stable base
explicitly after the current stable version has already been released.
The script checks npm's published versions and local and remote Git tags,
then chooses the next unused numbered `-beta.N`. Omit `--base` when continuing
an unreleased beta series already recorded in `package.json`.

`pnpm release:beta --base 2.2.7` updates the version and runs Biome, both
TypeScript checks, the build and Vitest suite, and Verdaccio consumer tests.
It leaves the result uncommitted for review.

`pnpm typecheck` checks the complete editor project and the stricter NodeNext
release tooling project. The root `tsconfig.json` includes the source, scripts,
tests, and main TypeScript configuration files with Node types, so VS Code uses
a configured project for them. Secondary TypeScript configs live under `config/`.
The build uses `config/tsconfig.source.json` to retain its original source settings.

`pnpm release:beta --base 2.2.7 --publish` requires a clean `main` checkout,
runs the same checks, commits `chore(release): <version>`, creates an annotated
`v<version>` tag, and atomically pushes the branch and tag to `origin`.
Release CI then tests and publishes it. If checks fail, inspect the retained
version change. If pushing fails, inspect the local commit and tag before retrying.
Do not rerun `--publish` from a dirty checkout prepared without that option.

## Stable releases

Set `package.json` to the intended stable version and run the same checks.
Commit the tested version to `main`, create an annotated `v<version>` tag on
that exact commit, and push it. The tag must match the manifest exactly.

## CI and publication

**Release** invokes the reusable **Pipeline**. The build and library tests run
across Linux, macOS, and Windows with Node 22, 24, and 26. The matrix excludes
`tests/tooling/**`; release tooling tests, Biome, type checks, coverage, and
Verdaccio verification run once on Ubuntu/Node 24. All jobs must pass before
release packaging starts.

External GitHub Actions are pinned to full commit SHAs, with release versions
in comments. Update the SHA and its version comment together after reviewing
the upstream release. The publishing job continues to use `Production`.

Packaging builds `dist`, stages the runtime and declarations alongside the
README and licence, and removes development dependencies and lifecycle hooks.
Both CommonJS and ESM consumers use `dist/index.cjs`; the manifest does not
advertise an unbuilt ESM entry. The staged package is packed once without
running lifecycle scripts and uploaded with the release tag and commit SHA.

The separate **Publish** workflow checks out trusted publication code from
the default-branch workflow revision. It downloads that tarball, verifies its
contents and version, confirms the successful build SHA against metadata and
the remote tag, then publishes the exact tarball without installing or building.
Stable versions use npm `latest`; `-beta.N` versions use npm `beta`.

Registry preflight skips an already-published version only when its SHA-512
integrity matches the uploaded tarball. Conflicting tarballs fail. Transient
publish failures are checked against the registry before retrying. Retry a
failed Publish job using the same uploaded artifact, rather than rebuilding
an already-published version.

## Registry tests and hooks

`pnpm test:verdaccio` starts the pinned Verdaccio development dependency on an
ephemeral loopback port with temporary storage, npm configuration, cache, and
publisher credentials. It builds and packs through the release staging code
and writes its temporary registry configuration as `config.yaml` for Verdaccio 7.
It publishes to the local registry and installs that exact version in independent
CommonJS and ESM projects. All four project/module combinations run in separate
Node processes and have individual results. Each project also exercises extension
lookup, `basePath`, and missing-file errors in a separate compatibility check. Dependency
installs use the registry's npm uplink and retain runtime installation scripts.
The registry and temporary projects are removed on success or failure.
Use `--format=cjs`, `--format=esm`, or `--verbose` to narrow or inspect a run.
The default output has numbered stages, timings, PASS/FAIL results, and a final
summary of every selected import pair. Failed and unrun checks are distinct.
`--verbose` adds subprocess output between stage headers and their results.

Lefthook replaces Husky. The root `prepare` script installs hooks after removing
only a local `core.hooksPath` left by Husky (`.husky` or `.husky/_`). Custom or
global hook settings are preserved. Hook installation is skipped in CI and
when `LEFTHOOK=0`. The pre-commit hook runs Biome on staged files and stages
its fixes; the commit-msg hook retains conventional commit validation.
Git commands use standard OS installation directories. Lefthook runs its installed
package CLI through Node, so project PATH entries and Windows `.cmd` shims cannot
replace either command.
