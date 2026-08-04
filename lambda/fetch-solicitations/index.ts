import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const snsClient = new SNSClient({});
const secretsClient = new SecretsManagerClient({});

const TABLE_NAME = process.env.TABLE_NAME!;
const TOPIC_ARN = process.env.TOPIC_ARN!;
const SECRET_ARN = process.env.SECRET_ARN!;

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

  const response = await fetch(url.toString());
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`SAM.gov API error ${response.status}: ${body}`);
  }

  const data: any = await response.json();
  return data.opportunitiesData ?? [];
}

async function isNew(noticeId: string): Promise<boolean> {
  const result = await ddbClient.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { noticeId } })
  );
  return !result.Item;
}

async function markSeen(opp: SamOpportunity): Promise<void> {
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
        ttl,
      },
    })
  );
}

function formatOpportunity(o: SamOpportunity): string {
  const lines = [`• ${o.title}`];
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

export const handler = async (): Promise<{ newCount: number }> => {
  const apiKey = await getApiKey();

  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const opportunities = await fetchOpportunities(
    apiKey,
    formatDate(yesterday),
    formatDate(today)
  );

  const newOnes: SamOpportunity[] = [];
  for (const opp of opportunities) {
    if (await isNew(opp.noticeId)) {
      newOnes.push(opp);
      await markSeen(opp);
    }
  }

  const messageBody = newOnes.length
    ? newOnes.map(formatOpportunity).join('\n\n')
    : 'No new solicitations posted in the last day.';

  await snsClient.send(
    new PublishCommand({
      TopicArn: TOPIC_ARN,
      Subject: `Rebel Radar: ${newOnes.length} new solicitation(s)`,
      Message: messageBody,
    })
  );

  return { newCount: newOnes.length };
};
