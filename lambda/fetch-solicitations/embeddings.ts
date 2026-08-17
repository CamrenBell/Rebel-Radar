import { createHash } from 'crypto';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const bedrockClient = new BedrockRuntimeClient({});

// Sentinel partition key used to stash the cached company-profile embedding
// in the same "solicitations" table used for dedup tracking, rather than
// standing up a new table or S3 bucket for a single small item. Real
// SAM.gov noticeIds won't collide with this value. See README.md for the
// rationale ("Company profile embedding cache" section).
const DEFAULT_PROFILE_EMBEDDING_KEY = '__COMPANY_PROFILE_EMBEDDING__';

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isThrottlingError(err: any): boolean {
  const name = err?.name ?? err?.__type ?? '';
  const status = err?.$metadata?.httpStatusCode;
  return (
    name === 'ThrottlingException' ||
    name === 'TooManyRequestsException' ||
    name === 'ServiceUnavailableException' ||
    name === 'ModelTimeoutException' ||
    status === 429 ||
    status === 500 ||
    status === 503
  );
}

/**
 * Calls Bedrock to embed a single piece of text with Titan Text Embeddings
 * V2, retrying with exponential backoff + jitter on throttling / transient
 * errors.
 */
export async function embedText(text: string, modelId: string, attempt = 0): Promise<number[]> {
  try {
    const response = await bedrockClient.send(
      new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({ inputText: text }),
      })
    );

    const payload = JSON.parse(new TextDecoder().decode(response.body));
    if (!Array.isArray(payload.embedding)) {
      throw new Error('Bedrock embedding response did not include an "embedding" array');
    }
    return payload.embedding as number[];
  } catch (err: any) {
    if (isThrottlingError(err) && attempt < MAX_RETRIES) {
      const delayMs = BASE_DELAY_MS * 2 ** attempt + Math.random() * 200;
      await sleep(delayMs);
      return embedText(text, modelId, attempt + 1);
    }
    throw err;
  }
}

/**
 * Generic small-concurrency worker pool. Used both for description-text
 * lookups and Bedrock embedding calls so we never fire off one request per
 * item (or one giant Promise.all) against an external service.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

/** Embeds a batch of texts, `concurrency` Bedrock calls in flight at a time. */
export async function embedBatch(
  texts: string[],
  modelId: string,
  concurrency: number
): Promise<number[][]> {
  return mapWithConcurrency(texts, (text) => embedText(text, modelId), concurrency);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Cannot compare vectors of different length (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function hashProfileText(profileText: string): string {
  return createHash('sha256').update(profileText).digest('hex');
}

/**
 * Returns the embedding vector for the company profile text, reusing the
 * cached vector in DynamoDB when the profile text and model haven't
 * changed. Only calls Bedrock (and re-caches) when there's no cache entry
 * yet, or the cached entry's text hash / model no longer matches.
 */
export async function getOrCreateProfileEmbedding(
  ddbClient: DynamoDBDocumentClient,
  tableName: string,
  profileText: string,
  modelId: string,
  profileEmbeddingKey: string = DEFAULT_PROFILE_EMBEDDING_KEY
): Promise<number[]> {
  const textHash = hashProfileText(profileText);

  const existing = await ddbClient.send(
    new GetCommand({ TableName: tableName, Key: { noticeId: profileEmbeddingKey } })
  );

  const cached = existing.Item;
  if (
    cached &&
    cached.profileTextHash === textHash &&
    cached.modelId === modelId &&
    Array.isArray(cached.embedding)
  ) {
    return cached.embedding as number[];
  }

  const embedding = await embedText(profileText, modelId);

  await ddbClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        noticeId: profileEmbeddingKey,
        profileTextHash: textHash,
        modelId,
        embedding,
        updatedAt: new Date().toISOString(),
        // Intentionally no `ttl` attribute: unlike solicitation records,
        // this cache entry should persist indefinitely until the profile
        // text changes (detected via profileTextHash above), not expire.
      },
    })
  );

  return embedding;
}
