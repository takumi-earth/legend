#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { LegendSecretsStack } from '../lib/legend-secrets-stack';
import { LegendEKSStack } from '../lib/legend-eks-stack';

const app = new cdk.App();

// 1) Deploy a stack that creates each config/credential in its own AWS Secrets Manager secret
const secretsStack = new LegendSecretsStack(app, 'LegendSecretsStack');

// 2) Deploy the EKS stack that uses those secrets (domainName, certArn, etc.)
const eksStack = new LegendEKSStack(app, 'LegendEKSStack', {
  // Pass the names of each secret to the EKS stack so it can retrieve them
  domainNameSecretName: secretsStack.domainNameSecret.secretName,
  certificateArnSecretName: secretsStack.certificateArnSecret.secretName,
  gitlabAppIdSecretName: secretsStack.gitlabAppIdSecret.secretName,
  gitlabAppSecretSecretName: secretsStack.gitlabAppSecret.secretName,
  grafanaAdminSecretName: secretsStack.grafanaAdminSecret.secretName
});

eksStack.addDependency(secretsStack);
