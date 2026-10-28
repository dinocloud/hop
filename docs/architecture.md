# Architecture

> DinoCloud Internal - Confidential · all data is synthetic

![Architecture](diagrams/architecture.png)

A serverless WhatsApp agent built on AWS Communication Developer Services (End User Messaging Social) and Amazon Bedrock AgentCore, defined end to end in AWS CDK (TypeScript). One stack, no containers, no servers.

## Components

| Component | AWS service | Role |
| --- | --- | --- |
| WhatsApp channel | End User Messaging Social | Sends templates, text and location messages; publishes every inbound webhook (messages and delivery statuses) to SNS |
| `package-status-hook` | API Gateway REST + Lambda (Node 24, arm64) | The shipping system reports package status; on `READY_AT_HOP` the customer gets the "package ready" template |
| `inbound-router` | SNS → Lambda (Node 24, arm64) | Parses the webhook, deduplicates, opens the 24-hour window, calls the agent, replies by WhatsApp |
| Agent | AgentCore Runtime, direct code deploy (`NODE_22`) | Strands Agents (TypeScript) with Claude on Bedrock; tools over DynamoDB; one isolated session per conversation |
| Data | DynamoDB (4 tables, on-demand, PITR) | Packages, pickup points, conversations, inbound-message dedupe |
| Observability | CloudWatch Logs/Metrics/Alarms, X-Ray | JSON logs with Powertools, custom metrics per failure path, one alarm each |
| Delivery | GitHub Actions + OIDC | Validate on every branch; deploy `main` with `cdk deploy` |

The WhatsApp number, the WhatsApp Business Account and the inbound SNS topic are created once outside the stack; the stack reads their IDs from SSM and only adds its own SNS subscription.

## Data model

| Table | Key | Attributes |
| --- | --- | --- |
| `hop-hackathon-packages` | PK `trackingId`; GSI `byPhone` (`phone`, `updatedAt`) | `customerName`, `status` (`IN_TRANSIT` · `READY_AT_HOP` · `DELIVERED` · `RETURNED`), `hopPointId`, `deadlineAt`, `scheduledAt`, `readyNotificationStatus`/`readyMessageId`, `updatedAt` |
| `hop-hackathon-hop-points` | PK `id` | `name`, `address`, `lat`, `lng`, `openingHours` |
| `hop-hackathon-conversations` | PK `phone` | `lastInboundAt` (24-hour window), `sessionId` (AgentCore session) |
| `hop-hackathon-inbound-messages` | PK `messageId`; TTL `expiresAt` | `status` (`PROCESSING` · `DONE`), `leaseUntil` — one item per WhatsApp message, processed exactly once |

Phones are stored in E.164 with `+`. Deadlines end at 23:59 Buenos Aires time (UTC-3), stored as ISO UTC.

## Flow 1: proactive notice (business-initiated)

```
Shipping system ─POST /packages/{id}/status (API key)─► API Gateway ─► package-status-hook
                                                                            ├─► DynamoDB Packages (status, deadline, notice record)
                                                                            └─► End User Messaging Social: template "paquete_listo"
```

1. API Gateway validates the API key and the JSON body against a model; the Lambda validates again with zod.
2. The hook reads the package, checks the state transition (`DELIVERED` and `RETURNED` are terminal), validates the pickup point and writes with an optimistic condition on `updatedAt`.
3. On `READY_AT_HOP` it sends the approved WhatsApp template with the customer name, pickup point and days left, and records the result on the package.

Business-initiated messages must be approved templates: that is a WhatsApp rule, and the reason this flow never sends free text.

### Status hook

`POST /packages/{trackingId}/status` with `{ status, hopPointId?, deadlineDays? }`:

| Code | Meaning |
| --- | --- |
| `202 { trackingId, status, notified, messageId?, duplicate? }` | Saved. `notified` tells whether the template went out |
| `400` | Invalid body, path or pickup point |
| `404` | Unknown package |
| `409` | The package changed between read and write; retry |
| `422` | Transition not allowed; don't retry |
| `503` | Template send failed for a transient reason; state saved, safe to retry |

Idempotent: a repeated `READY_AT_HOP` for the same point answers `duplicate: true` without resending or moving the deadline. Permanent send failures are recorded (`readyNotificationStatus: FAILED`) and raise the `TemplateSendFailed` metric and alarm.

## Flow 2: conversation (customer-initiated)

```
WhatsApp ─► End User Messaging Social ─► SNS ─► inbound-router ─► AgentCore Runtime (agent + tools) ─► DynamoDB
                                                      │                                                    
                                                      ├─► DynamoDB inbound-messages (claim / complete)
                                                      ├─► DynamoDB conversations (window, sessionId)
                                                      └─► End User Messaging Social: text + location pin
```

1. The SNS message carries the Meta webhook entry. Text messages and button taps are processed; media gets a fixed "text only for now" reply; delivery statuses are counted, and a `failed` status raises `ReplyDeliveryFailed`.
2. `claimMessage` takes a 70-second lease on the WhatsApp message id. A duplicate delivery is dropped; a lease still held by a dead invocation makes Lambda retry later instead of losing the message.
3. `touchInbound` opens the 24-hour window with the message timestamp and assigns the AgentCore `sessionId` (a UUID, stable per phone).
4. The Lambda invokes the runtime with `{ phone, text }` and the session id, within a time budget derived from the Lambda's remaining time (40 s max).
5. The reply is sent as text and, when the agent returns a `location`, as a WhatsApp location message. Once anything was sent, a later failure never triggers a retry (no duplicate replies).

## The agent

Strands Agents (TypeScript) on AgentCore Runtime, served by `bedrock-agentcore/runtime` (`/invocations`, `/ping`). Deployed as a single esbuild bundle uploaded to S3: the stack points `CfnRuntime` at the zip with runtime `NODE_22`, so a code change becomes a new runtime version with no container build.

- **Contract** (`src/lib/agent-contract.ts`, shared by Lambda and agent): request `{ phone, text }`, reply `{ text, location | null, degraded? }`.
- **The model never invents coordinates.** It answers JSON `{ text, hopPointId | null }` and the server builds the pin from DynamoDB; a pin only exists when the customer has a package ready at that point.
- **Privacy by construction.** Every tool is bound to the phone of the session: `get_my_packages` ignores any phone the user types, `get_package_by_tracking` returns "not found" for someone else's package, and tools never return phones or internal ids.
- **Tools**: `get_my_packages`, `get_package_by_tracking`, `get_hop_point`, `list_hop_points` (nearest first), `get_calendar`, plus demo helpers `send_package` and `confirm_dropoff`.
- **Actions** (`agent/src/actions.ts`): `extend_deadline` (1 to 7 days), `change_hop_point`, `reschedule_delivery` (tomorrow to 14 days), `request_return`. All are two-step: a preview with `confirmed: false`, then the write only after the customer says yes in the next message, and only if the package did not change in between.
- **Limits**: 6 tool turns, 4096 output tokens, 12-message sliding window per session, 30 s per request. One message at a time per session; a failed invocation discards the session so the thread never stays half-written.
- **Model**: `us.anthropic.claude-sonnet-5-5` through a cross-region inference profile, default sampling, low reasoning effort. English by default; it follows the customer's language.

## Reliability guarantees

| Guarantee | How |
| --- | --- |
| Each inbound message is processed exactly once | Conditional `UpdateItem` lease on `messageId` with TTL; `done` vs `in_progress` distinguished on retry |
| Never two replies | After the first send, failures are logged and metered but not retried; ambiguous send timeouts are not retried |
| Never a silent dead end | Agent failure → apology text (`AgentFailed`); unparseable event → `InboundParseError`; every path has a metric and an alarm; SNS → Lambda has a DLQ with alarm |
| Proactive notice sent once per arrival | Notice result stored on the package; repeated status calls are `duplicate` |
| No lost updates | Optimistic concurrency on `updatedAt` for the hook; state-transition checks |
| 24-hour window respected | Free-text and location sends check `lastInboundAt` with a 5-minute safety margin; business-initiated messages are templates |

## Security

- **Least privilege IAM**: DynamoDB grants per table and per action; `social-messaging:SendWhatsAppMessage` limited to the ARN of the one phone number; the Lambda can invoke only this runtime; the runtime role has read-only on the data it needs, Bedrock access only through the configured inference profile, and a trust policy conditioned on this account and region. A stack test fails on any `Resource: "*"` that is not X-Ray or namespaced `PutMetricData`.
- **Nothing hardcoded**: number IDs and topic ARN from SSM at deploy time; team phones only through environment variables; no secrets in the repo.
- **No PII in logs**: phones masked to the last four digits, message contents never logged, error objects carry masked values.
- **Edge**: API key + usage plan with throttling and daily quota, request validation, access logs. Reserved concurrency of 10 per Lambda bounds the impact on the shared account.
- **cdk-nag** (`AwsSolutionsChecks`) runs on every synth; each suppression lives next to the resource with a written reason.
- **Delivery**: GitHub OIDC role scoped to pushes on `main` of this repo, allowed only to assume the CDK bootstrap roles; `main` is branch-protected.

## Decisions and trade-offs

| Decision | Why |
| --- | --- |
| AgentCore Runtime with direct code deploy instead of a container | No Docker in the pipeline or on laptops; the bundle is a zip asset of the CDK stack, versioned with the stack |
| Strands Agents in TypeScript | One language across infra, Lambdas and agent; the AgentCore Node SDK provides the runtime server |
| Model returns `hopPointId`, server builds the location | Removes a whole class of hallucinated or injected pins |
| JSON by prompt instead of forced structured output | Current Claude models reject forced tool choice and non-default sampling; a tolerant parser falls back to plain text |
| Lease-based dedupe table instead of "last message id" | Handles out-of-order retries and invocations that die mid-way without losing or duplicating replies |
| Lambda timeout 20 s / 60 s with SDK timeouts | Always below API Gateway's 29 s; the agent gets a budget derived from the remaining time |
| Deadline at end of day, Buenos Aires time | What a customer expects from "you have 5 days"; dates reach the model already formatted in local time |
| `RemovalPolicy.DESTROY` on data | Hackathon in a shared account: the stack must be fully removable |

## Known limitations and next steps

- Two messages from the same customer arriving within a second may be answered out of order; strict ordering needs an SQS FIFO queue per phone in front of the Lambda.
- The AgentCore runtime log group is created by the service without retention (CloudFormation cannot adopt it).
- `send_package` and `confirm_dropoff` exist so anyone can try the demo; in a real deployment the shipping system owns those transitions.
- Network mode is `PUBLIC` and there is no inbound authorizer on the runtime (the only caller is the Lambda via SigV4); a production setup would move the runtime into a VPC.
- Per-phone rate limiting is not implemented.
