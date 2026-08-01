#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { RebelRadarStack } from '../lib/rebel-radar-stack';

const app = new cdk.App();

// Pass your alert email at deploy time:
//   cdk deploy -c alertEmail=you@rebelcontracting.com
const alertEmail = app.node.tryGetContext('alertEmail');

new RebelRadarStack(app, 'RebelRadarStack', {
  alertEmail,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
