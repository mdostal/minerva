# Contributing to Minerva

Minerva is a small, focused tool — issues and PRs are welcome, but please read this first so your
contribution lands smoothly.

## Before you start

For anything beyond a trivial fix (typo, small doc correction), open an issue first describing
what you want to change and why. Minerva has a deliberately narrow scope (see the README's "Why
it's its own thing" section and `VISION.md`) — a PR that expands scope without prior discussion is
likely to be asked to narrow before it's reviewed.

## Development setup

```bash
git clone https://github.com/mdostal/minerva.git
cd minerva
npm install
npm run ci   # test + typecheck -- the authoritative local gate
```

No build step — `bin/minerva.ts` runs directly via `tsx`.

## Discipline this project follows

- **TDD, strictly.** Named → interfaced → full TDD → locked. New behavior gets a failing test
  first, then the implementation that makes it pass. See any recent commit for the pattern.
- **`npm run ci` is the gate**, not GitHub Actions. Run it locally before opening a PR; the CI
  workflow's job is a shared cross-repo convenience layer, not the source of truth (some tests
  need a real `claude` CLI/subprocess environment that CI's sandbox doesn't have).
- **No mocking of the Pantheon subprocess ABI.** Tests exercise real subprocesses, real temp git
  repos, and real file I/O wherever the code under test does the same — see `docs/architecture.md`
  AD-1. A test that mocks around the thing it's supposed to verify will be asked to change.
- **Fail loud, never guess.** Invalid config throws with an actionable message rather than
  silently defaulting. Keep that discipline in new code.

## Pull requests

- Keep PRs scoped to one change. Reference the issue it addresses.
- Include tests for new behavior and for bug fixes (a regression test that would have caught the
  bug).
- `npm run ci` must pass locally before you open the PR.

## Reporting bugs / security issues

Regular bugs: open a GitHub issue. Security vulnerabilities: see [SECURITY.md](./SECURITY.md) —
please don't file those as public issues.

## License

By contributing, you agree your contributions are licensed under this project's [MIT
License](./LICENSE).
