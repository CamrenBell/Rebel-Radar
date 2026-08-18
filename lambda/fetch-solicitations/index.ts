import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { COMPANY_PROFILE_TEXT } from './company-profile';
import { cosineSimilarity, embedText, getOrCreateProfileEmbedding, mapWithConcurrency } from './embeddings';

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const snsClient = new SNSClient({});
const secretsClient = new SecretsManagerClient({});

const TABLE_NAME = process.env.TABLE_NAME!;
const TOPIC_ARN = process.env.TOPIC_ARN!;
const SECRET_ARN = process.env.SECRET_ARN!;

// --- Relevance scoring config -----------------------------------------
const EMBEDDING_MODEL_ID = process.env.EMBEDDING_MODEL_ID ?? 'amazon.titan-embed-text-v2:0';
const RELEVANCE_THRESHOLD = Number(process.env.RELEVANCE_THRESHOLD ?? '0.75');
const HIGH_RELEVANCE_THRESHOLD = Number(process.env.HIGH_RELEVANCE_THRESHOLD ?? '0.85');
const PROFILE_EMBEDDING_KEY = process.env.PROFILE_EMBEDDING_KEY ?? '__COMPANY_PROFILE_EMBEDDING__';
// Bedrock calls in flight at once when embedding solicitations, and HTTP
// calls in flight at once when resolving description text. Kept modest so
// a busy day doesn't blow past Bedrock's default per-account TPS limit or
// the Lambda's own timeout.
const EMBED_CONCURRENCY = Number(process.env.EMBED_CONCURRENCY ?? '15');

interface SamOpportunity {
  noticeId: string;
  title: string;
  solicitationNumber?: string;
  type?: string;
  baseType?: string;
  postedDate: string;
  // NOTE: "reponseDeadLine" is misspelled in the SAM.gov API response itself.
  // Keep the typo — renaming it here would just make the field come back undefined.
  reponseDeadLine?: string;
  naicsCode?: string;
  // SAM.gov's Opportunities API does not return a human-readable NAICS
  // description alongside naicsCode. This field is left optional/unpopulated
  // for now (blob building below degrades gracefully); wiring up a NAICS
  // code -> description lookup is a natural follow-on but out of scope here.
  naicsDescription?: string;
  setAside?: string;
  setAsideCode?: string;
  uiLink?: string;
  fullParentPathName?: string;
  classificationCode?: string;
  placeOfPerformance?: {
    city?: { name?: string };
    state?: { name?: string };
  };
  active?: string;
  // Raw link to the full description text, not the resolved text itself.
  description?: string;
}

interface ScoredOpportunity {
  opportunity: SamOpportunity;
  score: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tripped for the rest of a single Lambda invocation once SAM.gov responds
 * with 429 to any call. SAM.gov's 429 has repeatedly turned out to mean
 * "daily request quota exhausted," not a short per-second throttle, so
 * backing off and retrying the same request is pointless and just spends
 * more of a quota that's already gone. Once tripped, remaining
 * description-text lookups short-circuit locally (degrading gracefully to
 * an empty description, same as any other resolution failure) instead of
 * making a network call we already know will fail.
 */
interface SamQuotaState {
  exhausted: boolean;
}

function formatDate(d: Date): string {
  // SAM.gov API expects MM/dd/yyyy
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

async function getApiKey(): Promise<string> {
  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
  const secretValue = JSON.parse(result.SecretString ?? '{}');
  if (!secretValue.apiKey) {
    throw new Error('SAM.gov API key not found in secret. Expected JSON shape: {"apiKey": "..."}');
  }
  return secretValue.apiKey;
}

const FETCH_MAX_RETRIES = 3;
const FETCH_BASE_DELAY_MS = 500;

async function fetchOpportunities(
  apiKey: string,
  postedFrom: string,
  postedTo: string
): Promise<SamOpportunity[]> {
  const url = new URL('https://api.sam.gov/opportunities/v2/search');
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('postedFrom', postedFrom);
  url.searchParams.set('postedTo', postedTo);
  url.searchParams.set('limit', '1000');
  // ptype = notice type code; 'o' = Solicitation. Narrows results to solicitations
  // only, per the SAM.gov Opportunities API notice type codes.
  url.searchParams.set('ptype', 'o');

  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url.toString());
    if (response.ok) {
      const data: any = await response.json();
      return data.opportunitiesData ?? [];
    }

    const body = await response.text();
    // 429 from SAM.gov has consistently meant "daily request quota
    // exhausted" rather than a short-lived throttle -- retrying just spends
    // more of a quota that's already gone, so fail immediately instead of
    // backing off. Only retry genuinely transient failures (5xx).
    if (response.status !== 429 && response.status >= 500 && attempt < FETCH_MAX_RETRIES) {
      await sleep(FETCH_BASE_DELAY_MS * 2 ** attempt + Math.random() * 200);
      continue;
    }
    throw new Error(`SAM.gov API error ${response.status}: ${body}`);
  }
}

async function isNew(noticeId: string): Promise<boolean> {
  const result = await ddbClient.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { noticeId } })
  );
  return !result.Item;
}

async function markSeen(opp: SamOpportunity, score: number, label: string): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 90; // keep 90 days
  await ddbClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        noticeId: opp.noticeId,
        title: opp.title,
        solicitationNumber: opp.solicitationNumber,
        type: opp.type,
        baseType: opp.baseType,
        postedDate: opp.postedDate,
        reponseDeadLine: opp.reponseDeadLine,
        naicsCode: opp.naicsCode,
        setAside: opp.setAside,
        setAsideCode: opp.setAsideCode,
        uiLink: opp.uiLink,
        fullParentPathName: opp.fullParentPathName,
        classificationCode: opp.classificationCode,
        placeOfPerformance: opp.placeOfPerformance,
        active: opp.active,
        descriptionLink: opp.description,
        // Relevance score against the company profile at the time this
        // solicitation was processed, stored for every new solicitation
        // (not just the ones that made the email) so scores can be
        // spot-checked in the table later, independent of the digest.
        // NOTE: reflects RELEVANCE_THRESHOLD/EMBEDDING_MODEL_ID as configured
        // at write time — re-scoring after a threshold or profile change
        // does not retroactively update already-written items.
        relevanceScore: score,
        relevanceLabel: label,
        ttl,
      },
    })
  );
}

function stripHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Titan Text Embeddings V2 accepts up to ~8K tokens; this is a conservative
// character-based cap (well under that) so one oversized description can't
// fail the whole embedding call.
const MAX_DESCRIPTION_CHARS = 6000;

/**
 * SAM.gov's `description` field on a search result is a link to fetch the
 * full description text, not the text itself. Best-effort resolve it for
 * embedding purposes — on any failure (timeout, non-2xx, bad JSON) fall
 * back to an empty string rather than failing the run.
 */
async function resolveDescriptionText(
  link: string | undefined,
  apiKey: string,
  samQuota: SamQuotaState
): Promise<string> {
  if (!link) return '';
  if (samQuota.exhausted) return '';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const url = new URL(link);
    if (!url.searchParams.has('api_key')) {
      url.searchParams.set('api_key', apiKey);
    }
    const response = await fetch(url.toString(), { signal: controller.signal });
    if (!response.ok) {
      if (response.status === 429) samQuota.exhausted = true;
      return '';
    }

    const raw = await response.text();
    let text = raw;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.description === 'string') {
        text = parsed.description;
      }
    } catch {
      // Not JSON — treat the raw body as the description text.
    }
    return stripHtml(text).slice(0, MAX_DESCRIPTION_CHARS);
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

function buildEmbeddingBlob(o: SamOpportunity, descriptionText: string): string {
  const naics = o.naicsCode
    ? `${o.naicsCode}${o.naicsDescription ? ` - ${o.naicsDescription}` : ''}`
    : 'Not specified';
  const setAsideType = o.setAside ?? o.setAsideCode ?? 'None specified';

  return [
    `Title: ${o.title ?? ''}`,
    `NAICS: ${naics}`,
    `Set-Aside: ${setAsideType}`,
    `Description: ${descriptionText || 'Not available'}`,
  ].join('\n');
}

function relevanceLabel(score: number): string {
  if (score >= HIGH_RELEVANCE_THRESHOLD) return 'High';
  if (score >= RELEVANCE_THRESHOLD) return 'Medium';
  return 'Low';
}

/**
 * Scores newly-seen opportunities against the cached company profile
 * embedding and checkpoints each one to DynamoDB (via markSeen) as soon as
 * its own score is computed — not after the whole batch finishes. That way
 * a timeout or crash partway through only loses the items still in flight;
 * everything already scored stays marked "seen" and won't be re-fetched
 * (re-spending SAM.gov request quota) on the next run.
 *
 * A single item's failure (Bedrock exhausts its own retries, etc.) is
 * caught and logged rather than aborting the batch — that item is simply
 * left unmarked and will be picked up again on a future run.
 *
 * Returns every opportunity that was successfully scored, unfiltered and in
 * input order — callers decide what to do with items below
 * RELEVANCE_THRESHOLD (currently: still recorded in DynamoDB as "Low", just
 * left out of the email).
 */
async function scoreAndPersistOpportunities(
  opportunities: SamOpportunity[],
  apiKey: string
): Promise<ScoredOpportunity[]> {
  if (opportunities.length === 0) return [];

  const profileEmbedding = await getOrCreateProfileEmbedding(
    ddbClient,
    TABLE_NAME,
    COMPANY_PROFILE_TEXT,
    EMBEDDING_MODEL_ID,
    PROFILE_EMBEDDING_KEY
  );

  const samQuota: SamQuotaState = { exhausted: false };
  const results: (ScoredOpportunity | undefined)[] = new Array(opportunities.length);

  await mapWithConcurrency(
    opportunities,
    async (opportunity, i) => {
      try {
        const descriptionText = await resolveDescriptionText(opportunity.description, apiKey, samQuota);
        const blob = buildEmbeddingBlob(opportunity, descriptionText);
        const vector = await embedText(blob, EMBEDDING_MODEL_ID);
        const score = cosineSimilarity(vector, profileEmbedding);

        await markSeen(opportunity, score, relevanceLabel(score));
        results[i] = { opportunity, score };
      } catch (err) {
        // Leave this one unmarked (not persisted as "seen") so it's picked
        // up again on a future run instead of silently dropped, and don't
        // let one bad item take down the rest of the batch.
        console.error(`Failed to score/persist opportunity ${opportunity.noticeId}:`, err);
      }
    },
    EMBED_CONCURRENCY
  );

  return results.filter((r): r is ScoredOpportunity => r !== undefined);
}

function formatOpportunity(o: SamOpportunity, score: number): string {
  const lines = [`• [${relevanceLabel(score)} relevance, ${score.toFixed(2)}] ${o.title}`];
  if (o.solicitationNumber) lines.push(`  Solicitation #: ${o.solicitationNumber}`);
  if (o.type) lines.push(`  Type: ${o.type}`);
  if (o.reponseDeadLine) lines.push(`  Response deadline: ${o.reponseDeadLine}`);
  if (o.naicsCode) lines.push(`  NAICS: ${o.naicsCode}`);
  if (o.setAside) lines.push(`  Set-aside: ${o.setAside}`);
  if (o.fullParentPathName) lines.push(`  Agency: ${o.fullParentPathName}`);

  const city = o.placeOfPerformance?.city?.name;
  const state = o.placeOfPerformance?.state?.name;
  if (city || state) {
    lines.push(`  Place of performance: ${[city, state].filter(Boolean).join(', ')}`);
  }

  if (o.uiLink) lines.push(`  ${o.uiLink}`);

  return lines.join('\n');
}

/**
 * Publishes a short "the run failed" notice so a bad day is never silent —
 * previously any thrown error (timeout, SAM.gov 429, etc.) skipped the SNS
 * publish entirely and nobody heard anything. Best-effort: if even this
 * fails, we log and give up rather than throwing a second error out of a
 * catch block.
 */
async function publishFailureNotice(error: unknown, context: string): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  try {
    await snsClient.send(
      new PublishCommand({
        TopicArn: TOPIC_ARN,
        Subject: 'Rebel Radar: run failed',
        Message: `Today's solicitation check did not complete.\n\n${context}\n\nError: ${message}`,
      })
    );
  } catch (notifyErr) {
    console.error('Failed to publish failure notice to SNS:', notifyErr);
  }
}

export const handler = async (): Promise<{ newCount: number; relevantCount: number }> => {
  try {
    const apiKey = await getApiKey();

    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    const opportunities = await fetchOpportunities(
      apiKey,
      formatDate(yesterday),
      formatDate(today)
    );

    // Phase 1: figure out which opportunities are new (read-only; no writes
    // yet).
    const candidates: SamOpportunity[] = [];
    for (const opp of opportunities) {
      if (await isNew(opp.noticeId)) {
        candidates.push(opp);
      }
    }

    // Phase 2: score every candidate (not just the ones that will end up in
    // the email), checkpointing each one to DynamoDB as it finishes so a
    // timeout or crash partway through doesn't lose already-completed work
    // or cause it to be redone (and re-billed against SAM.gov's daily
    // request quota) on the next run.
    const allScored = await scoreAndPersistOpportunities(candidates, apiKey);

    // Phase 3: only solicitations at/above RELEVANCE_THRESHOLD go in the
    // email, ranked best match first.
    const scored = allScored
      .filter((s) => s.score >= RELEVANCE_THRESHOLD)
      .sort((a, b) => b.score - a.score);

    const messageBody = scored.length
      ? scored.map((s) => formatOpportunity(s.opportunity, s.score)).join('\n\n')
      : 'No new relevant solicitations posted in the last day.';

    await snsClient.send(
      new PublishCommand({
        TopicArn: TOPIC_ARN,
        Subject: `Rebel Radar: ${scored.length} relevant solicitation(s)`,
        Message: messageBody,
      })
    );

    return { newCount: allScored.length, relevantCount: scored.length };
  } catch (err) {
    console.error('Rebel Radar run failed:', err);
    await publishFailureNotice(
      err,
      'Any solicitations already scored before the failure were still recorded and will not be re-processed.'
    );
    // Re-throw so the invocation is still recorded as an error in CloudWatch
    // (for any alarms/metrics watching invocation errors). This is now safe
    // to do without causing a retry storm: the EventBridge rule target has
    // retryAttempts set to 0, so this failure will NOT trigger an automatic
    // same-day re-invocation — it just waits for tomorrow's schedule.
    throw err;
  }
};
