import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

// Keep in sync with lambda/fetch-solicitations/index.ts's EMBEDDING_MODEL_ID
// default — used here to scope the Bedrock IAM permission to this one model.
const EMBEDDING_MODEL_ID = 'amazon.titan-embed-text-v2:0';

export interface RebelRadarStackProps extends cdk.StackProps {
  /** Email address to receive the daily solicitation digest */
  alertEmail?: string;
  /**
   * Minimum cosine-similarity score (0–1) a solicitation must have against
   * the company profile embedding to be included in the email digest at
   * all. Deploy-time override: `cdk deploy -c relevanceThreshold=0.7`
   */
  relevanceThreshold?: string;
  /**
   * Cosine-similarity score (0–1) at/above which a solicitation is labeled
   * "High" relevance instead of "Medium" in the digest. Must stay >=
   * relevanceThreshold to be meaningful. Deploy-time override:
   * `cdk deploy -c highRelevanceThreshold=0.9`
   */
  highRelevanceThreshold?: string;
}

export class RebelRadarStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: RebelRadarStackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------------
    // Secret: SAM.gov API key
    // After first deploy, set the real value with:
    //   aws secretsmanager put-secret-value \
    //     --secret-id <SecretArn from stack output> \
    //     --secret-string '{"apiKey":"YOUR_SAM_GOV_API_KEY"}'
    // ---------------------------------------------------------------------
    const samApiSecret = new secretsmanager.Secret(this, 'SamGovApiKey', {
      description: 'API key for api.sam.gov (Rebel Radar)',
    });

    // ---------------------------------------------------------------------
    // Table: tracks solicitations we've already alerted on
    // ---------------------------------------------------------------------
    const seenTable = new dynamodb.Table(this, 'SeenSolicitations', {
      tableName: 'solicitations',
      partitionKey: { name: 'noticeId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ---------------------------------------------------------------------
    // SNS topic + email subscription for the daily digest
    // ---------------------------------------------------------------------
    const alertTopic = new sns.Topic(this, 'RebelRadarAlerts', {
      displayName: 'Rebel Radar - New Solicitations',
    });

    if (props?.alertEmail) {
      alertTopic.addSubscription(new subscriptions.EmailSubscription(props.alertEmail));
    }

    // ---------------------------------------------------------------------
    // Lambda: fetches new solicitations and publishes the digest
    // ---------------------------------------------------------------------
    const fetchFn = new lambdaNode.NodejsFunction(this, 'FetchSolicitationsFn', {
      entry: path.join(__dirname, '../lambda/fetch-solicitations/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        TABLE_NAME: seenTable.tableName,
        TOPIC_ARN: alertTopic.topicArn,
        SECRET_ARN: samApiSecret.secretArn,
        EMBEDDING_MODEL_ID,
        RELEVANCE_THRESHOLD: props?.relevanceThreshold ?? '0.75',
        HIGH_RELEVANCE_THRESHOLD: props?.highRelevanceThreshold ?? '0.85',
      },
    });

    seenTable.grantReadWriteData(fetchFn);
    alertTopic.grantPublish(fetchFn);
    samApiSecret.grantRead(fetchFn);

    // ---------------------------------------------------------------------
    // Bedrock: relevance-scoring embeddings (Titan Text Embeddings V2)
    // Scoped to the one model the Lambda actually calls, not all of Bedrock.
    // ---------------------------------------------------------------------
    fetchFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          `arn:${cdk.Aws.PARTITION}:bedrock:${this.region}::foundation-model/${EMBEDDING_MODEL_ID}`,
        ],
      })
    );

    // ---------------------------------------------------------------------
    // Schedule: 13:00 UTC daily (~6:00 AM Mountain Time)
    // NOTE: EventBridge cron does not auto-adjust for daylight saving time.
    // This will run ~7 AM MDT in summer / 6 AM MST in winter. Adjust the
    // hour manually if that drift matters, or add scheduling logic later.
    // ---------------------------------------------------------------------
    const rule = new events.Rule(this, 'DailySchedule', {
      schedule: events.Schedule.cron({ minute: '0', hour: '13' }),
      description: 'Triggers Rebel Radar daily solicitation check',
    });
    rule.addTarget(new targets.LambdaFunction(fetchFn));

    // ---------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------
    new cdk.CfnOutput(this, 'SamApiSecretArn', { value: samApiSecret.secretArn });
    new cdk.CfnOutput(this, 'AlertTopicArn', { value: alertTopic.topicArn });
    new cdk.CfnOutput(this, 'SeenTableName', { value: seenTable.tableName });
  }
}
