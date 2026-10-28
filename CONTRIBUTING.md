# Contributing

Short version: branch from `main`, keep every check green, open a pull request that says how to verify it, and never deploy from your laptop.

## Workflow

1. Branch from `main`: `feat/<ticket>-<slug>`, `fix/...`, `docs/...`, `chore/...`.
2. Run the checks before pushing (they are exactly what CI runs):
   ```bash
   npm run typecheck && npm run lint && npm run format:check && npm test && npm run build:agent && npm run smoke:agent && npm run synth
   ```
3. Open a pull request against `main`. If your change depends on another open PR, open it against that branch ("stacked"); GitHub retargets it when the base merges.
4. One review, green CI, then merge. Merging to `main` deploys: there is no other way to deploy, on purpose.

Commit messages follow `type(scope): what and why` in the imperative (`feat(agent): ...`, `fix(hook): ...`, `docs: ...`).

## What a pull request should contain

- **What it does** and the ticket it covers (ClickUp list "Hop Team - Hackthon").
- **How to verify**: the commands or the WhatsApp messages to send, and what should happen. If it can only be verified after the deploy, say so and include the commands.
- **Decisions** worth knowing, especially anything that is on purpose but looks odd.
- Tests for the behaviour you add or change. Unit tests mock AWS with `aws-sdk-client-mock`; infra tests assert on the synthesized template.

Every PR so far was also reviewed adversarially by a second model (an independent review of the diff, with findings fixed before merge) and the findings are summarized in the PR description. It is not mandatory, but it caught real bugs; keep doing it for anything non-trivial.

## Rules of the shared account

The dev account hosts other projects. Changes must:

- stay inside the single stack `HopHackathonDev` and keep the `hop-hackathon-` prefix on every named resource;
- never touch account-level settings (IAM account configuration, the API Gateway CloudWatch role, the CDK bootstrap, the GitHub OIDC provider);
- never modify or delete resources the stack did not create: the WhatsApp number and WABA, the SSM parameters under `/hop-hackathon/dev/whatsapp/*` and the inbound SNS topic are read-only for us;
- keep `cdk diff` output limited to our own resources before merging.

## Code conventions

- **No hardcoded identifiers or secrets.** IDs and ARNs come from SSM at deploy time or from `cdk.json` context; phones come from environment variables; nothing sensitive goes in the repo, the logs or the PR description.
- **Least privilege by default.** Grant per table and per action; scope every ARN; if a wildcard is unavoidable, add a cdk-nag suppression next to the resource with a reason. A test fails on unjustified `Resource: "*"`.
- **No PII in logs.** Use `maskPhone`; never log message contents; errors must not carry full phone numbers.
- **Shared code lives in `src/lib`** and is imported by both Lambdas and the agent (`agent-contract.ts` is the contract between them: change both sides together).
- **Dates**: deadlines are end of day in Buenos Aires; anything shown to a customer is formatted in local time before it reaches the model.
- TypeScript strict, ESM, Prettier (140 columns, single quotes), ESLint with typescript-eslint.

## Documentation

- `README.md` is the entry point for anyone (including judges): keep it short and accurate.
- `docs/how-to-run.md` holds the step-by-step commands; `docs/architecture.md` the design; `docs/usage-guide.md` the message-by-message script for testers; `docs/e2e-y-demo.md` the verified runbook and demo script; `docs/referencia-tecnica.md` the detailed reference in Spanish.
- If a PR changes behaviour that any of these describe, update the doc in the same PR.
- The architecture diagram is generated from `docs/diagrams/architecture.py`; regenerate it when the stack changes.
