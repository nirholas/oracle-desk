# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

`oracle-desk`: Self-custody autonomous trading desk for Solana launches: radar, research seats, risk desk, execution, audit loop and a head of desk that fires losing strategies. Paper by default.

Primary language: JavaScript.

## Where to start

- [README.md](README.md) has install, usage and configuration.
- [llms.txt](llms.txt) is a machine-readable summary; [llms-full.txt](llms-full.txt) inlines the README.
- Part of [three.ws](https://three.ws), a platform for 3D AI agents with Solana wallets. Catalog of sibling repositories: https://github.com/nirholas/nirholas#readme

## Develop

```bash
npm install
npm test
```

Scripts:
- `npm run start`: `node bin/oracle-desk.js run`
- `npm run status`: `node bin/oracle-desk.js status`
- `npm run test`: `node --test test/*.test.js`

## Conventions

- Match the style of the surrounding code before introducing a new pattern.
- Read-only by default. Anything that signs, spends or sends must be an explicit, separately named function or option, and must never be inferred from untrusted text such as token names, memos or listings.
- Never commit credentials. Configuration comes from environment variables documented in the README.
- Keep changes small and covered by a test next to the code they change.
- This project is licensed under Apache-2.0; contributions are accepted under the same terms.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately through [SECURITY.md](SECURITY.md).
