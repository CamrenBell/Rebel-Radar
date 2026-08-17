#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { RebelRadarStack } from '../lib/rebel-radar-stack';

const app = new cdk.App();

// Pass your alert email at deploy time:
//   cdk deploy -c alertEmail=you@rebelcontracting.com
const alertEmail = app.node.tryGetContext('alertEmail');

// Optional relevance-scoring threshold overrides, e.g.:
//   cdk deploy -c relevanceThreshold=0.7 -c highRelevanceThreshold=0.9
const relevanceThreshold = app.node.tryGetContext('relevanceThreshold');
const highRelevanceThreshold = app.node.tryGetContext('highRelevanceThreshold');

new RebelRadarStack(app, 'RebelRadarStack', {
  alertEmail,
  relevanceThreshold,
  highRelevanceThreshold,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
