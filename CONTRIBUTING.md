# Contributing

## Run the tests before opening a PR

Four suites. All four must pass. Use Node ≥ 22.5 to run the complete repository suite because
`credential-console` uses built-in SQLite; the three Codex-only packages still support Node ≥ 20.

```bash
npm test --prefix codex-credential/client-agent
npm test --prefix codex-credential/refresh-center
npm test --prefix codex-credential/token-dispenser
cd credential-console && npm test -- test/*.test.js
```

There is also a shell-level installer test, which CI runs:

```bash
bash codex-credential/client-agent/test/install-fallback.test.sh
```

CI additionally syntax-checks every `.js`, `.mjs`, and `.sh` file, and runs the Windows ACL
test on `windows-latest`.

## Never commit a secret

Do not commit a credential, a certificate pin, a bearer or enrollment token, a private key, a
real IP address, or an internal hostname — not in code, not in tests, not in documentation
examples. Use obvious placeholders (`<dispenser-host>`, `owner@example.com`,
`<sha256-cert-pin>`).

`.gitignore` covers the usual filenames, but it is a safety net, not a review step. Check your
own diff. If something did get committed, treat it as leaked: rotate or revoke it first, then
worry about rewriting history.

## No lockfile

This repository has **no runtime npm dependencies**. Every component runs on the Node standard
library and is tested with the built-in `node --test` runner, so there is no lockfile to
update and `npm ci` is not part of the build. Adding a runtime dependency is a design change
and should be raised in an issue first.

## Documentation changes

The docs are deliberately terse: statements of fact and constraint.

- Do not add a measurement, benchmark, date, or verification claim you have not made yourself.
  If you have made it, say what you measured and against which version.
- Do not add marketing language.
- If you are unsure whether something is true, say less rather than more.
- Keep deployment guidance operator-facing and generic. It should read as instructions for
  anyone, not as one organisation's deployment history.
