# Rebel Radar

Rebel Radar is a tool built for Rebel Contracting that scrapes SAM.gov via its public API to surface relevant government contract opportunities. It runs on a daily schedule, checks for solicitations posted in the last 24 hours, and emails a digest of new titles so Rebel Contracting can find and apply for contracts faster.

This repo contains the AWS CDK (TypeScript) infrastructure-as-code for Rebel Radar.

## Architecture

- **EventBridge** — scheduled rule that triggers the Lambda daily at 13:00 UTC (~6 AM Mountain Time)
- **Lambda** — calls the SAM.gov Opportunities API, filters to solicitations posted since the last run, and publishes new ones
- **DynamoDB** — tracks solicitation IDs already alerted on, so re-runs don't send duplicates (90-day TTL)
- **Secrets Manager** — stores the SAM.gov API key
- **SNS (email)** — delivers the daily digest of new solicitation titles

## Status

🚧 In early development. Current scope: daily email digest of new solicitation titles, no filtering by NAICS code/keyword yet.

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
