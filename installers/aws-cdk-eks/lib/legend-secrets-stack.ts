import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as kms from 'aws-cdk-lib/aws-kms';

/**
 * Creates ONE secret per value:
 *   1) domainName
 *   2) certificateArn
 *   3) gitlabAppId
 *   4) gitlabAppSecret
 *   5) grafanaAdminPassword
 *
 * In practice, you can store truly non-sensitive items (like domainName/certArn) in Parameter Store
 * or pass them in as context. But to fully satisfy "each secret is stored separately in Secrets Manager,"
 * we create distinct secrets below.
 */
export class LegendSecretsStack extends cdk.Stack {
  public readonly domainNameSecret: secretsmanager.Secret;
  public readonly certificateArnSecret: secretsmanager.Secret;
  public readonly gitlabAppIdSecret: secretsmanager.Secret;
  public readonly gitlabAppSecret: secretsmanager.Secret;
  public readonly grafanaAdminSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // KMS Key for secrets encryption
    const secretsKey = new kms.Key(this, 'LegendSecretsKey', {
      enableKeyRotation: true,
      alias: 'legend-secrets-key'
    });

    // 1) Domain Name (not truly secret, but stored in Secrets Manager per your request)
    this.domainNameSecret = new secretsmanager.Secret(this, 'LegendDomainNameSecret', {
      secretName: 'legend/domainName',
      description: 'Legend domain name',
      encryptionKey: secretsKey,
      generateSecretString: {
        // We'll just store a static default here; update it out-of-band if needed
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'value', 
        // Overwrite the generated value with your real domain in the console or via CLI
        passwordLength: 1 // ensures an empty string is not generated, just "x" as placeholder
      }
    });

    // 2) Certificate ARN
    this.certificateArnSecret = new secretsmanager.Secret(this, 'LegendCertificateArnSecret', {
      secretName: 'legend/certificateArn',
      description: 'ACM certificate ARN for Legend domain',
      encryptionKey: secretsKey,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'value',
        passwordLength: 1 // minimal stub
      }
    });

    // 3) GitLab Application ID
    this.gitlabAppIdSecret = new secretsmanager.Secret(this, 'LegendGitLabAppIdSecret', {
      secretName: 'legend/gitlabAppId',
      description: 'GitLab App ID for Legend OAuth',
      encryptionKey: secretsKey,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'value',
        passwordLength: 1
      }
    });

    // 4) GitLab Application Secret
    this.gitlabAppSecret = new secretsmanager.Secret(this, 'LegendGitLabAppSecret', {
      secretName: 'legend/gitlabAppSecret',
      description: 'GitLab App Secret for Legend OAuth',
      encryptionKey: secretsKey,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'value',
        excludePunctuation: false
      }
    });

    // 5) Grafana admin password
    this.grafanaAdminSecret = new secretsmanager.Secret(this, 'LegendGrafanaAdminSecret', {
      secretName: 'legend/grafanaAdminPassword',
      description: 'Admin password for Grafana UI',
      encryptionKey: secretsKey,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'value',
        passwordLength: 16,
        excludePunctuation: false
      }
    });

    new cdk.CfnOutput(this, 'DomainNameSecretName', {
      value: this.domainNameSecret.secretName
    });
    new cdk.CfnOutput(this, 'CertificateArnSecretName', {
      value: this.certificateArnSecret.secretName
    });
    new cdk.CfnOutput(this, 'GitLabAppIdSecretName', {
      value: this.gitlabAppIdSecret.secretName
    });
    new cdk.CfnOutput(this, 'GitLabAppSecretSecretName', {
      value: this.gitlabAppSecret.secretName
    });
    new cdk.CfnOutput(this, 'GrafanaAdminSecretName', {
      value: this.grafanaAdminSecret.secretName
    });
  }
}
