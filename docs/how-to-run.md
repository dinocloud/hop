# How to run

> AWS CDS Agentic AI Hackathon · a DinoCloud project · all data is synthetic

Everything you need to go from a clean clone to a working WhatsApp agent: local checks, deployment, seed data, trying each flow, and watching it in CloudWatch. For the design, see [Architecture](architecture.md); for the message-by-message script, see the [usage guide](usage-guide.md).

## 1. Prerequisites

| Tool | Version | Why |
| --- | --- | --- |
| Node.js + npm | 22 or newer | Lambdas, agent, CDK and scripts are all TypeScript |
| AWS CLI v2 | any recent | seed data, manual checks, one-time setup |
| Git + GitHub access | | `dinocloud/hop`, pull requests, Actions |

No Docker. Python is only needed if you regenerate the architecture diagram (`docs/diagrams/architecture.py`), never to build, test or deploy. The agent is bundled with esbuild and deployed to AgentCore Runtime as a zip (direct code deploy), and the Lambdas are bundled the same way.

**AWS account**: the project lives in the DinoCloud dev account (`359328299440`, `us-east-1`), which is shared with other projects. Every resource is prefixed `hop-hackathon-`. The WhatsApp number, the WhatsApp Business Account and the SNS topic for inbound messages were set up once by hand and are only read by the stack (their IDs live in SSM under `/hop-hackathon/dev/whatsapp/*`).

### Credentials

**Day to day** (seed, test scripts, reading logs, `cdk diff`): the SSO profile is enough. It is the same identity for every command in this guide unless stated otherwise.

```bash
aws sso login --profile dino-dev
export AWS_PROFILE=dino-dev AWS_REGION=us-east-1
```

The CDK CLI does not resolve the `sso-session` profile format on its own. For `cdk diff` or `cdk synth` against the account, export the profile's credentials first; this does not change which permissions you have:

```bash
eval "$(aws configure export-credentials --profile dino-dev --format env)"
export AWS_REGION=us-east-1
```

**One-time setup only** (deploying the OIDC role, section 4): creating IAM roles needs administrator rights. Use the admin SSO role for that single command and go back to `dino-dev` afterwards. Nothing else in this guide needs it, and no deploy ever runs from a laptop.

```bash
eval "$(aws configure export-credentials --profile AdministratorAccess-359328299440 --format env)"
```

## 2. Install and check

```bash
git clone git@github.com:dinocloud/hop.git
cd hop
npm ci
```

Run the same checks CI runs, in the same order:

```bash
npm run typecheck      # tsc --noEmit
npm run lint           # ESLint (typescript-eslint)
npm run format:check   # Prettier
npm test               # vitest: 200+ unit and infra tests
npm run build:agent    # bundles agent/src into agent/dist/index.js (~2.5 MB, CommonJS)
npm run smoke:agent    # loads the bundle from a folder WITHOUT node_modules, as the runtime does
npm run synth          # cdk synth --strict with cdk-nag; no AWS credentials needed
```

`synth` is deterministic: account and region come from `cdk.json`, SSM values are resolved at deploy time, and `cdk.json` rebuilds the agent bundle before synthesizing. Any cdk-nag finding without a justified suppression fails the build.

Useful while developing:

```bash
npm run test:watch
npm run format         # rewrite files with Prettier
npm run diff           # cdk diff against the deployed stack (needs credentials)
```

## 3. Run the agent locally

The agent is an HTTP server that implements the AgentCore Runtime contract (`POST /invocations`, `GET /ping`, port 8080). You can run it on your machine; it talks to Bedrock and DynamoDB with your credentials.

```bash
npm run build:agent
cd agent/dist
PACKAGES_TABLE=hop-hackathon-packages \
HOP_POINTS_TABLE=hop-hackathon-hop-points \
CONVERSATIONS_TABLE=hop-hackathon-conversations \
INBOUND_MESSAGES_TABLE=hop-hackathon-inbound-messages \
AWS_REGION=us-east-1 node index.js
```

In another terminal:

```bash
curl -s localhost:8080/ping
curl -s -X POST localhost:8080/invocations \
  -H 'content-type: application/json' \
  -H 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: 0123456789abcdef0123456789abcdef0123' \
  -d '{"phone":"+5491112345678","text":"Where is my package?"}'
```

The reply is `{ "text": "...", "location": { lat, lng, name, address } | null }`. Without AWS credentials you get the graceful fallback text (`degraded: true`), which is also what the Lambda sends when the agent fails. The session id header must be at least 33 characters; the runtime enforces it.

## 4. Deploy

**Nobody deploys from a laptop.** Merging to `main` triggers `.github/workflows/deploy.yml`, which validates (same steps as CI), assumes an IAM role through GitHub OIDC and runs `cdk diff` + `cdk deploy HopHackathonDev --exclusively`. The job only runs for `main`, even with `workflow_dispatch`.

### One-time setup (already done in `dino-dev`)

Only needed for a new account or repo:

1. Deploy the OIDC role, with the admin credentials from section 1 (the only step that needs them). It reuses the GitHub OIDC provider that already exists in the account and can only assume the CDK bootstrap roles of the region.
   ```bash
   npm run deploy:ci-role
   ```
2. Copy the `DeployRoleArn` output into GitHub as a repository **variable** `AWS_DEPLOY_ROLE_ARN` (Settings → Secrets and variables → Actions → Variables).
3. Protect `main` (pull request with one review, no direct push, required CI checks). This is the real gate: the CDK execution role is an administrator in the account, and the OIDC trust only accepts tokens from pushes to `main`.

The OIDC subject uses GitHub's immutable form (`repo:dinocloud@<id>/hop@<id>:ref:refs/heads/main`); the prefix is the `hop:githubSubjectPrefix` context in `cdk.json`.

### Configuration

Everything configurable is in `cdk.json` context; nothing is hardcoded in code:

| Context key | Default | What it is |
| --- | --- | --- |
| `hop:account`, `hop:region`, `hop:stage` | `359328299440`, `us-east-1`, `dev` | Target environment |
| `hop:templateName` / `hop:templateLanguage` | `paquete_listo` / `es_AR` | WhatsApp template used by the proactive notice. The template is approved by Meta in `es_AR` and `en`; set the language to the one you want the notice in |
| `hop:metaApiVersion` | `v23.0` | Cloud API version passed to End User Messaging Social |
| `hop:agentModelId` | `us.anthropic.claude-sonnet-5-5` | Bedrock inference profile for the agent |
| `hop:githubRepo`, `hop:githubSubjectPrefix` | | OIDC trust for the deploy role |

Values that come from the WhatsApp setup are read from SSM at deploy time (`/hop-hackathon/dev/whatsapp/aws-phone-number-id` and `.../inbound-topic-arn`); the stack never stores them.

## 5. Seed data

```bash
SEED_PHONES=+5491112345678,+5491187654321 npm run seed
```

Loads 3 pickup points in Buenos Aires and 10 packages in every state, assigned in order to the phones in `SEED_PHONES` (team phones, never committed). Idempotent: run it as often as you like, it only refreshes dates.

To add one phone without reseeding (someone joins the demo from another phone):

```bash
npm run add:package -- +5491112345678 --name Lean --point hop-belgrano --days 3
npm run add:package -- +5491112345678 --status IN_TRANSIT     # a package "on its way", for the proactive notice
```

You don't actually need this for a first contact: if a phone with no packages writes to the number, the agent registers one for it.

## 6. Try it

### The conversational flow (anyone with WhatsApp)

Write to the number from your phone and follow the [usage guide](usage-guide.md). The first message opens the 24-hour customer-service window; replies and the map pin only go out inside that window.

Without a phone, publish a synthetic inbound event to the SNS topic (the phone you name receives the real reply, and must have written to the number before, or Meta rejects the reply with code 131047):

```bash
npm run publish:inbound -- +5491112345678 "Where is my package?"
aws logs tail /aws/lambda/hop-hackathon-inbound-router --since 5m --follow --format short
```

### The agent alone (no WhatsApp in the middle)

```bash
ARN=$(aws ssm get-parameter --name /hop-hackathon/dev/app/agent-runtime-arn --query Parameter.Value --output text)
aws bedrock-agentcore invoke-agent-runtime \
  --agent-runtime-arn "$ARN" \
  --runtime-session-id "$(uuidgen | tr -d '-')0000" \
  --content-type application/json --accept application/json \
  --payload "$(printf '{"phone":"+5491112345678","text":"Where is my package?"}' | base64)" /dev/stdout
```

`--content-type` is mandatory (otherwise the runtime answers 415) and the session id needs 33+ characters.

### The proactive notice (shipping-system side)

```bash
API_URL=$(aws cloudformation describe-stacks --stack-name hop-hackathon-dev --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)
KEY_ID=$(aws cloudformation describe-stacks --stack-name hop-hackathon-dev --query "Stacks[0].Outputs[?OutputKey=='HookApiKeyId'].OutputValue" --output text)
API_KEY=$(aws apigateway get-api-key --api-key "$KEY_ID" --include-value --query value --output text)

curl -s -X POST "${API_URL}packages/HOP-0003/status" \
  -H "x-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{"status":"READY_AT_HOP","hopPointId":"hop-palermo","deadlineDays":5}' | jq .
```

Expected: `202` with `notified: true` and a `messageId`; the template arrives on the phone that owns `HOP-0003`. Repeating the same call answers `duplicate: true` and sends nothing: the hook is idempotent. Full response table in the [architecture doc](architecture.md#status-hook).

```bash
aws dynamodb get-item --table-name hop-hackathon-packages --key '{"trackingId":{"S":"HOP-0003"}}' \
  --query 'Item.{status:status.S,point:hopPointId.S,deadline:deadlineAt.S,notice:readyNotificationStatus.S}'
```

`deadlineAt` is the end of day N in Buenos Aires (UTC-3), so the ISO value reads as the next day in UTC.

## 7. Watch it

| What | Where |
| --- | --- |
| Inbound Lambda | log group `/aws/lambda/hop-hackathon-inbound-router` |
| Hook Lambda | `/aws/lambda/hop-hackathon-package-status-hook` |
| Agent runtime | `/aws/bedrock-agentcore/runtimes/<runtimeId>-DEFAULT` (`aws logs describe-log-groups --log-group-name-prefix /aws/bedrock-agentcore/runtimes/hop_hackathon_agent`) |
| API access logs | `/aws/apigateway/hop-hackathon-api-access` |
| Alarms | `aws cloudwatch describe-alarms --alarm-name-prefix hop-hackathon` |
| Traces | X-Ray is on for both Lambdas |

Logs are JSON (Powertools). Phones are masked to the last four digits and message contents are never logged. To follow one person end to end, filter by the masked phone; `sessionId` links the Lambda logs with the runtime logs:

```
fields @timestamp, level, message, messageId, sessionId
| filter phone = "***5678"
| sort @timestamp asc
```

Custom metrics live in the `HopHackathon` namespace (`InboundProcessed`, `InboundDuplicate`, `AgentFailed`, `ReplyFailed`, `ReplyDeliveryFailed`, `TemplateSendFailed`, ...). Each failure path has an alarm; see the [reference](referencia-tecnica.md#alarmas).

## 8. Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| "I can't find your package" | The phone you wrote from has no packages, or the tracking number belongs to someone else (privacy by design) | Ask without a tracking number, or `npm run add:package` |
| No reply, `ReplyDeliveryFailed` alarm, status `failed` 131047 | 24-hour window closed on Meta's side | Write from the phone first, then retry |
| Reply is the apology text | Agent session was starting (first message after ~15 min idle) or two messages arrived together | Wait a few seconds, send one message at a time |
| Hook answers `notified: false` | Template not approved for that language, or a permanent send error; state is saved and `readyNotificationStatus: FAILED` | Check `TemplateSendFailed` logs; repeat the call once fixed |
| Hook answers `422` | Transition not allowed (`DELIVERED` and `RETURNED` are terminal) | Nothing to retry |
| `npm run synth` fails with cdk-nag errors | A new resource needs a scoped permission or a justified suppression next to it | Fix the resource; don't suppress globally |
| CDK locally says it can't find credentials | The `sso-session` profile format | Use `aws configure export-credentials` (section 1) |

More cases, with the exact commands, in the [E2E runbook](e2e-y-demo.md#si-algo-falla-en-vivo).

## 9. Clean up

```bash
npx cdk destroy HopHackathonDev     # tables, Lambdas, API, SNS subscription, DLQ, runtime
npx cdk destroy HopHackathonCi      # the GitHub deploy role; then delete AWS_DEPLOY_ROLE_ARN in GitHub
```

The WhatsApp number, WABA, SSM parameters and SNS topic were created outside the stack and are removed separately (the number has a monthly charge).
