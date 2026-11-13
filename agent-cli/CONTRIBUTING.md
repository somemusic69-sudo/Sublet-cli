# Contributing to Sublera CLI

Thanks for helping make peer-to-peer GPU hosting less fragile.

## Development setup

```bash
cd agent-cli
npm install
npm run typecheck
npm test
npm run build
node dist/index.js --help
```

End-to-end checks need the central Sublera server:

```bash
# from the server checkout
npm start

# from agent-cli
npm run e2e
```

## What to work on

- Bug fixes and reliability improvements are always welcome.
- For a large feature, open an issue first so we can agree on the shape.
- Keep the CLI standalone. It must not import server source or require a
  browser to run a host.
- Never log host keys, prompts, or model contents. Logs go to stderr so the
  terminal dashboard stays usable.

## Pull request checklist

- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.
- [ ] `npm run build` passes.
- [ ] New behavior has a test where it is practical.
- [ ] No secrets, tokens, model files, or machine-specific paths are committed.
- [ ] README is updated if the command surface or server contract changes.

## Commit style

Use a short imperative subject. Examples:

```text
fix: keep booking state across a process crash
feat: serve jobs without a second terminal
docs: describe the host tunnel contract
```

## Licensing

By submitting a contribution you agree that it is licensed under the MIT
License in [LICENSE](LICENSE). Do not add dependencies with incompatible
licenses.
