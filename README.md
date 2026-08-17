# Rebel Radar

Rebel Radar is a tool built for Rebel Contracting that scrapes SAM.gov via its public API to surface relevant government contract opportunities. It runs on a daily schedule, checks for solicitations posted in the last 24 hours, and emails a digest of new titles so Rebel Contracting can find and apply for contracts faster.

This repo contains the AWS CDK (TypeScript) infrastructure-as-code for Rebel Radar.

## Architecture

- **EventBridge** — scheduled rule that triggers the Lambda daily at 13:00 UTC (~6 AM Mountain Time)
- **Lambda** — calls the SAM.gov Opportunities API, filters to solicitations posted since the last run, scores the new ones for relevance, and publishes the ones that pass the bar
- **DynamoDB** — tracks solicitation IDs already alerted on so re-runs don't send duplicates (90-day TTL), and doubles as the cache for the company-profile embedding (see below, no TTL on that item)
- **Bedrock (Titan Text Embeddings V2)** — embeds the company profile once (cached) and each new solicitation per run, for relevance scoring
- **Secrets Manager** — stores the SAM.gov API key
- **SNS (email)** — delivers the daily digest of new, relevant solicitations

## Status

🚧 In early development. Current scope: daily email digest of new solicitations, filtered and ranked by semantic relevance to Rebel Contracting's capabilities. No NAICS/keyword pre-filtering yet, and the EventBridge schedule doesn't adjust for daylight saving time.

## Relevance scoring

Every solicitation that survives the dedup check is scored for relevance before it's allowed into the email digest:

1. **Company profile embedding.** [lambda/fetch-solicitations/company-profile.ts](lambda/fetch-solicitations/company-profile.ts) holds a `COMPANY_PROFILE_TEXT` constant — Rebel Contracting's capabilities write-up. On each invocation the Lambda checks DynamoDB for a cached embedding of that exact text (keyed by a SHA-256 hash of the string, stored in the same `solicitations` table under a reserved partition key, `__COMPANY_PROFILE_EMBEDDING__`, so real SAM.gov notice IDs never collide with it). If the cache is missing or the text has changed since it was cached, the Lambda calls Bedrock once to re-embed it and updates the cache — otherwise it reuses the cached vector. That cache entry deliberately has no TTL; it should live until the profile text changes, not expire on a timer.

   We reused the existing DynamoDB table instead of adding a new table or an S3 bucket because it's a single small item (a ~1024-float vector, well under DynamoDB's item size limit), the table is already granted read/write to this Lambda, and it avoids new infrastructure for what's effectively one row of cached data.

2. **Solicitation embeddings.** For each new/deduped solicitation, the Lambda builds a text blob (`Title` / `NAICS` / `Set-Aside` / `Description`) and embeds it with Titan Text Embeddings V2 (`amazon.titan-embed-text-v2:0`). Embedding calls run through a small worker pool (15 concurrent by default) with exponential backoff + jitter on Bedrock throttling, rather than sequentially or all at once.

   The SAM.gov search response only gives a *link* to the full description text, not the text itself, so the Lambda resolves that link (also via a small concurrent worker pool, best-effort — a failed fetch falls back to an empty description rather than failing the run) before building the blob.

3. **Scoring and filtering.** Each solicitation vector is compared to the cached profile vector via in-memory cosine similarity — no OpenSearch or other vector store. Every new solicitation gets a score and a label (`High` at/above `HIGH_RELEVANCE_THRESHOLD`, `Medium` at/above `RELEVANCE_THRESHOLD`, `Low` below it), written to its record in the `solicitations` DynamoDB table as `relevanceScore` / `relevanceLabel` — so you can spot-check how anything scored, including solicitations that got filtered out, directly in the table. Only what's at/above `RELEVANCE_THRESHOLD` (`High`/`Medium`) makes it into the email, sorted by score descending.

   Scoring happens *before* a solicitation is written to DynamoDB, not after — if Bedrock scoring fails partway through a run, nothing gets marked "seen" without a score, so a transient Bedrock outage can't silently drop a solicitation forever. It just gets picked up and scored again on the next run.

   Note that `relevanceScore`/`relevanceLabel` are a snapshot from whatever `RELEVANCE_THRESHOLD` / `HIGH_RELEVANCE_THRESHOLD` / company profile text were in effect at write time — changing the threshold or profile later doesn't retroactively re-label already-written items.

### Config

| Env var / CDK context | Default | Purpose |
| --- | --- | --- |
| `RELEVANCE_THRESHOLD` (context: `relevanceThreshold`) | `0.75` | Minimum cosine similarity to include a solicitation in the email at all. |
| `HIGH_RELEVANCE_THRESHOLD` (context: `highRelevanceThreshold`) | `0.85` | Cosine similarity at/above which a solicitation is labeled "High" instead of "Medium". |
| `EMBEDDING_MODEL_ID` | `amazon.titan-embed-text-v2:0` | Bedrock model used for both the profile and solicitation embeddings. The Lambda's IAM policy is scoped to this exact model. |
| `PROFILE_EMBEDDING_KEY` | `__COMPANY_PROFILE_EMBEDDING__` | Partition key used to cache the profile embedding in the `solicitations` table. |
| `EMBED_CONCURRENCY` | `15` | Max concurrent Bedrock/description-fetch calls per run. |

Override the threshold context values the same way `alertEmail` is passed:

```bash
npx cdk deploy -c alertEmail=you@rebelcontracting.com -c relevanceThreshold=0.7 -c highRelevanceThreshold=0.9
```

### Updating the company profile

Edit `COMPANY_PROFILE_TEXT` in [lambda/fetch-solicitations/company-profile.ts](lambda/fetch-solicitations/company-profile.ts) and redeploy. The embedding cache hashes that string, so a changed profile is detected and re-embedded automatically on the next run — no other code changes needed.

The profile currently in place reflects Rebel Contracting's actual capabilities (facilities services, installation/delivery, small-crew or subcontractor-managed prime work, Colorado/Midwest with nationwide one-offs, VOSB pending CVE certification). Update it here whenever that positioning changes — new focus areas, certification status, service area, etc.

## Prerequisites

- Node.js 20+
- AWS CLI configured with credentials for the target account
- AWS CDK CLI (`npm install -g aws-cdk`), or use `npx cdk`
- A [SAM.gov API key](https://sam.gov/data-services)

## Setup

```bash
npm install
```

Bootstrap your AWS account for CDK (one-time per account/region):

```bash
npx cdk bootstrap
```

## Deploy

```bash
npx cdk deploy -c alertEmail=you@rebelcontracting.com
```

After deploy, set the real SAM.gov API key in Secrets Manager (the secret ARN is printed as a stack output):

```bash
aws secretsmanager put-secret-value \
  --secret-id <SamApiSecretArn from output> \
  --secret-string '{"apiKey":"YOUR_SAM_GOV_API_KEY"}'
```

Confirm the SNS email subscription — check your inbox for a confirmation link after deploy.

## Useful commands

- `npx cdk diff` — see what would change before deploying
- `npx cdk synth` — output the generated CloudFormation template
- `npx cdk destroy` — tear down the stack

## Roadmap ideas

- Filter by NAICS code / keyword relevant to Rebel Contracting's capabilities
- Slack delivery option alongside/instead of email
- Web dashboard of historical solicitations
