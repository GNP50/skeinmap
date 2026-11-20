# Changesets

This folder holds [Changesets](https://github.com/changesets/changesets): small Markdown files
that describe a user-facing change and the semver bump it needs.

- Add one with `npx changeset` (or `npm run changeset`) in any pull request that changes
  behaviour, the public API, the published files or the supported environments. Pick `patch`,
  `minor` or `major` and write one or two sentences for the changelog.
- Internal changes (tests, CI, refactors with no visible effect) need no changeset.
- On `main`, the release workflow turns the pending changesets into a "Version Packages" pull
  request; merging it publishes the new version to npm.
