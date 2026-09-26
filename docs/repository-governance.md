# Repository Governance

## Current repository workflow

Development is expected to use:

```
focused branch
-> pull request
-> CI
-> squash merge
-> main
```

Direct development on `main` is discouraged.

## Required GitHub setting

The repository currently needs a protected `main` branch or equivalent repository ruleset.

Recommended minimum rule:

### Target

```
main
```

### Pull requests

- require a pull request before merging
- do not allow direct pushes to `main`
- require conversation resolution when review threads exist

For a solo-maintained repository, requiring an external approval is optional; requiring the PR path itself is the important baseline.

### Status checks

Require these checks before merge:

- `verify`
- `postgres-integration`

The workflow names/jobs must be confirmed in the GitHub UI when creating the rule because GitHub displays exact check-context names.

### History / merge policy

Preferred merge method:

```
squash
```

The repository may keep merge/rebase methods technically available during prototyping, but project policy is to use squash merges for focused PRs.

### Force push / deletion

Recommended:

- block force pushes to `main`
- block branch deletion for `main`

## Why this matters

The repository already contains strong automated checks, including real PostgreSQL integration coverage.

Without branch protection, those checks are advisory: an administrator can still push or merge without them.

Branch protection converts the existing CI investment into an enforced repository invariant.

## Release policy

See [Release Policy](release-policy.md).

## Security changes

Changes affecting any of the following require explicit regression coverage and, where semantic, an ADR:

- tenant boundary
- principal/actor binding
- role authorization
- Case lifecycle
- handoff ownership
- completion evidence
- optimistic concurrency
- event immutability
- membership lifecycle
- credential routing
- browser token/session handling

## Production note

Repository governance does not equal production approval.

Production readiness remains governed by [Production Release Checklist](release-checklist.md).
