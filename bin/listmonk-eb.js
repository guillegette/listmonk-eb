'use strict';
const cdk = require('aws-cdk-lib');
const { ListmonkEbStack } = require('../lib/listmonk-eb-stack');

const app = new cdk.App();
new ListmonkEbStack(app, 'ListmonkEbStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' }
});