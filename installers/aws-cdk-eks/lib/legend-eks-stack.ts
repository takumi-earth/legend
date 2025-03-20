import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Duration } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as docdb from 'aws-cdk-lib/aws-docdb';
import { LegendPlatform } from './legend-platform';

interface LegendEKSStackProps extends cdk.StackProps {
  domainNameSecretName: string;
  certificateArnSecretName: string;
  gitlabAppIdSecretName: string;
  gitlabAppSecretSecretName: string;
  grafanaAdminSecretName: string;
}

export class LegendEKSStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LegendEKSStackProps) {
    super(scope, id, props);

    // Retrieve each secret independently (no JSON fields)
    const domainNameSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'DomainNameSecret',
      props.domainNameSecretName
    );
    const certificateArnSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'CertificateArnSecret',
      props.certificateArnSecretName
    );
    const gitlabAppIdSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'GitLabAppIdSecret',
      props.gitlabAppIdSecretName
    );
    const gitlabAppSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'GitLabAppSecret',
      props.gitlabAppSecretSecretName
    );
    const grafanaAdminSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'GrafanaAdminSecret',
      props.grafanaAdminSecretName
    );

    // KMS key for EKS secrets encryption (optional but recommended)
    const clusterKmsKey = new kms.Key(this, 'LegendClusterKmsKey', {
      enableKeyRotation: true,
      alias: 'legend-eks-cluster-key'
    });

    // Create a VPC for EKS cluster and DocumentDB
    const vpc = new ec2.Vpc(this, 'LegendVpc', {
      maxAzs: 3,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }
      ]
    });

    // EKS Cluster
    const cluster = new eks.Cluster(this, 'LegendEKSCluster', {
      vpc,
      version: eks.KubernetesVersion.V1_26,
      secretsEncryptionKey: clusterKmsKey,
      defaultCapacity: 0
    });

    // Add self-managed or managed node group
    const nodegroup = cluster.addNodegroupCapacity('LegendNodeGroup', {
      instanceTypes: [new ec2.InstanceType('t3.large')],
      desiredSize: 3,
      minSize: 2,
      maxSize: 6,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }
    });

    // Tag for cluster autoscaler
    cdk.Tags.of(nodegroup).add(`k8s.io/cluster-autoscaler/${cluster.clusterName}`, 'owned');
    cdk.Tags.of(nodegroup).add('k8s.io/cluster-autoscaler/enabled', 'true');

    // DocumentDB with user "legend" and random password
    const docdbSecurityGroup = new ec2.SecurityGroup(this, 'DocDBSG', { vpc });
    docdbSecurityGroup.addIngressRule(nodegroup.nodeRole, ec2.Port.tcp(27017), 'Allow DocDB from EKS');

    const docdbCluster = new docdb.DatabaseCluster(this, 'LegendDocDBCluster', {
      engine: docdb.DatabaseClusterEngine.AMAZON_DOCDB,
      instanceProps: {
        vpc,
        instanceType: new ec2.InstanceType('t3.medium'),
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [docdbSecurityGroup]
      },
      instances: 2,
      masterUser: docdb.Credentials.fromGeneratedSecret('legend'),
      backupRetention: Duration.days(7),
      storageEncrypted: true
    });
    // Single-user rotation 
    docdbCluster.addRotationSingleUser();

    // IRSA for AWS Load Balancer Controller
    const albSA = cluster.addServiceAccount('AwsLoadBalancerControllerSA', {
      name: 'aws-load-balancer-controller',
      namespace: 'kube-system'
    });
    albSA.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'elasticloadbalancing:*',
        'ec2:Describe*',
        'ec2:CreateSecurityGroup', 'ec2:DeleteSecurityGroup',
        'ec2:AuthorizeSecurityGroupIngress', 'ec2:RevokeSecurityGroupIngress',
        'ec2:CreateTags', 'ec2:DeleteTags',
        'acm:ListCertificates', 'acm:DescribeCertificate',
        'iam:CreateServiceLinkedRole', 'iam:GetServerCertificate', 'iam:ListServerCertificates',
        'waf:*', 'wafv2:*', 'shield:*', 'cognito-idp:DescribeUserPoolClient'
      ],
      resources: ['*']
    }));

    // Deploy AWS Load Balancer Controller
    cluster.addHelmChart('AWSLoadBalancerController', {
      chart: 'aws-load-balancer-controller',
      release: 'aws-load-balancer-controller',
      repository: 'https://aws.github.io/eks-charts',
      namespace: 'kube-system',
      values: {
        clusterName: cluster.clusterName,
        serviceAccount: {
          create: false,
          name: albSA.serviceAccountName
        }
      }
    });

    // IRSA for Cluster Autoscaler
    const caSA = cluster.addServiceAccount('ClusterAutoscalerSA', {
      name: 'cluster-autoscaler',
      namespace: 'kube-system'
    });
    caSA.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'autoscaling:DescribeAutoScalingGroups',
        'autoscaling:DescribeAutoScalingInstances',
        'autoscaling:DescribeLaunchConfigurations',
        'autoscaling:DescribeTags',
        'autoscaling:SetDesiredCapacity',
        'autoscaling:TerminateInstanceInAutoScalingGroup',
        'ec2:DescribeLaunchTemplateVersions',
        'ec2:DescribeInstanceTypes',
        'ec2:DescribeImages',
        'ec2:GetInstanceTypesFromInstanceRequirements'
      ],
      resources: ['*']
    }));

    // Deploy Cluster Autoscaler
    cluster.addHelmChart('ClusterAutoscaler', {
      chart: 'cluster-autoscaler',
      release: 'cluster-autoscaler',
      repository: 'https://kubernetes.github.io/autoscaler',
      namespace: 'kube-system',
      values: {
        autoDiscovery: { clusterName: cluster.clusterName },
        awsRegion: this.region,
        rbac: {
          serviceAccount: {
            create: false,
            name: caSA.serviceAccountName
          }
        }
      }
    });

    // IRSA for Secrets Store CSI
    const csiSA = cluster.addServiceAccount('SecretsStoreCSISA', {
      name: 'secrets-store-csi-driver',
      namespace: 'kube-system'
    });
    csiSA.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:GetSecretValue',
        'secretsmanager:DescribeSecret'
      ],
      // In production, limit resources to only the 5 secrets + docdb secret:
      resources: ['*']
    }));

    // Deploy Secrets Store CSI driver
    cluster.addHelmChart('SecretsStoreCsiDriver', {
      chart: 'secrets-store-csi-driver',
      release: 'csi-driver',
      repository: 'https://kubernetes-sigs.github.io/secrets-store-csi-driver/charts',
      namespace: 'kube-system',
      values: {
        syncSecret: { enabled: true }
      }
    });

    // Deploy AWS Provider for Secrets Store CSI
    cluster.addHelmChart('SecretsStoreCsiAwsProvider', {
      chart: 'secrets-store-csi-driver-provider-aws',
      release: 'csi-provider-aws',
      repository: 'https://aws.github.io/secrets-store-csi-driver-provider-aws',
      namespace: 'kube-system',
      values: {
        serviceAccount: { 
          create: false,
          name: csiSA.serviceAccountName
        }
      }
    });

    // Deploy Kube Prometheus Stack (Prometheus & Grafana)
    cluster.addHelmChart('KubePrometheusStack', {
      chart: 'kube-prometheus-stack',
      release: 'kube-prom-stack',
      repository: 'https://prometheus-community.github.io/helm-charts',
      namespace: 'monitoring',
      createNamespace: true,
      values: {
        grafana: {
          // We'll dynamically load the password in Kubernetes from the Secrets Store CSI.
          // But if you want to do it purely via Helm values, you must handle that differently.
          // This is just a placeholder so the chart won't generate a random password itself.
          adminPassword: 'placeholder'
        }
      }
    });

    // Finally deploy the Legend platform components
    new LegendPlatform(this, 'LegendPlatform', {
      cluster,
      vpc,
      domainNameSecret,
      certificateArnSecret,
      gitlabAppIdSecret,
      gitlabAppSecret,
      grafanaAdminSecret,
      docdbCluster
    });
  }
}
