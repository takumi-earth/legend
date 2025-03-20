import { Construct } from 'constructs';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as docdb from 'aws-cdk-lib/aws-docdb';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';

interface LegendPlatformProps {
  cluster: eks.Cluster;
  vpc: ec2.Vpc;
  domainNameSecret: Secret;
  certificateArnSecret: Secret;
  gitlabAppIdSecret: Secret;
  gitlabAppSecret: Secret;
  grafanaAdminSecret: Secret;
  docdbCluster: docdb.DatabaseCluster;
}

export class LegendPlatform extends Construct {
  constructor(scope: Construct, id: string, props: LegendPlatformProps) {
    super(scope, id);

    const { cluster, vpc, domainNameSecret, certificateArnSecret, gitlabAppIdSecret, gitlabAppSecret, grafanaAdminSecret, docdbCluster } = props;

    const namespace = 'legend';

    // 1) Create the namespace
    const ns = cluster.addManifest('LegendNamespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: namespace }
    });

    // 2) Create one SecretProviderClass *per* secret (no JSON lumps). 
    //    Each secret gets mounted & synced to a distinct K8s Secret. 
    //    We'll call them "legend-domain-secret", "legend-cert-secret", etc.
    const domainSpc = this.createSecretProviderClass(cluster, 'domain-spc', namespace, domainNameSecret.secretArn, 'legend-domain-secret', 'LEGEND_DOMAIN');
    const certSpc   = this.createSecretProviderClass(cluster, 'cert-spc',   namespace, certificateArnSecret.secretArn, 'legend-certificate-secret', 'LEGEND_CERT_ARN');
    const gitlabIdSpc = this.createSecretProviderClass(cluster, 'gitlab-id-spc', namespace, gitlabAppIdSecret.secretArn, 'legend-gitlab-id-secret', 'GITLAB_APP_ID');
    const gitlabSecretSpc = this.createSecretProviderClass(cluster, 'gitlab-secret-spc', namespace, gitlabAppSecret.secretArn, 'legend-gitlab-secret', 'GITLAB_APP_SECRET');
    const grafanaSpc = this.createSecretProviderClass(cluster, 'grafana-spc', namespace, grafanaAdminSecret.secretArn, 'legend-grafana-secret', 'GRAFANA_ADMIN_PASSWORD');

    // DocumentDB master secret
    if (!docdbCluster.secret) {
      throw new Error('DocumentDB cluster has no master secret. Make sure docdb is configured with generated credentials.');
    }
    const docdbSpc = this.createSecretProviderClass(cluster, 'docdb-spc', namespace, docdbCluster.secret.secretArn, 'legend-docdb-secret', 'DOCDB_PASSWORD', 'password', 'username', 'DOCDB_USERNAME');

    // Define environment variables for each Legend service referencing the synced K8s secrets
    // Each environment variable references a distinct K8s secret. 
    const commonEnv = [
      // Domain name (synced from "legend-domain-secret", key: "LEGEND_DOMAIN")
      { name: 'LEGEND_DOMAIN', valueFrom: { secretKeyRef: { name: 'legend-domain-secret', key: 'LEGEND_DOMAIN' } } },
      // GitLab OAuth
      { name: 'GITLAB_APP_ID', valueFrom: { secretKeyRef: { name: 'legend-gitlab-id-secret', key: 'GITLAB_APP_ID' } } },
      { name: 'GITLAB_APP_SECRET', valueFrom: { secretKeyRef: { name: 'legend-gitlab-secret', key: 'GITLAB_APP_SECRET' } } },
      // DocumentDB 
      { name: 'DOCDB_HOST', value: docdbCluster.clusterEndpoint.hostname },
      { name: 'DOCDB_PORT', value: docdbCluster.clusterEndpoint.port.toString() },
      { name: 'DOCDB_NAME', value: 'legend' },
      // The username & password come from the docdb spc
      { name: 'DOCDB_USER', valueFrom: { secretKeyRef: { name: 'legend-docdb-secret', key: 'DOCDB_USERNAME' } } },
      { name: 'DOCDB_PASS', valueFrom: { secretKeyRef: { name: 'legend-docdb-secret', key: 'DOCDB_PASSWORD' } } }
    ];

    // Helper: create Deployment & Service for each Legend component
    const makeDeployment = (appName: string, image: string, port: number) => ({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: appName, namespace },
      spec: {
        replicas: 2,
        selector: { matchLabels: { app: appName } },
        template: {
          metadata: { labels: { app: appName } },
          spec: {
            volumes: [
              {
                name: `${appName}-domain-vol`,
                csi: {
                  driver: 'secrets-store.csi.k8s.io',
                  readOnly: true,
                  volumeAttributes: { secretProviderClass: 'domain-spc' }
                }
              },
              {
                name: `${appName}-cert-vol`,
                csi: {
                  driver: 'secrets-store.csi.k8s.io',
                  readOnly: true,
                  volumeAttributes: { secretProviderClass: 'cert-spc' }
                }
              },
              {
                name: `${appName}-gitlabid-vol`,
                csi: {
                  driver: 'secrets-store.csi.k8s.io',
                  readOnly: true,
                  volumeAttributes: { secretProviderClass: 'gitlab-id-spc' }
                }
              },
              {
                name: `${appName}-gitlabsecret-vol`,
                csi: {
                  driver: 'secrets-store.csi.k8s.io',
                  readOnly: true,
                  volumeAttributes: { secretProviderClass: 'gitlab-secret-spc' }
                }
              },
              {
                name: `${appName}-grafana-vol`,
                csi: {
                  driver: 'secrets-store.csi.k8s.io',
                  readOnly: true,
                  volumeAttributes: { secretProviderClass: 'grafana-spc' }
                }
              },
              {
                name: `${appName}-docdb-vol`,
                csi: {
                  driver: 'secrets-store.csi.k8s.io',
                  readOnly: true,
                  volumeAttributes: { secretProviderClass: 'docdb-spc' }
                }
              }
            ],
            containers: [
              {
                name: appName,
                image,
                imagePullPolicy: 'Always',
                ports: [{ containerPort: port }],
                env: commonEnv,
                // The volumes are mounted read-only for completeness, though we only rely on K8s Secret sync
                volumeMounts: [
                  { name: `${appName}-domain-vol`, mountPath: `/mnt/${appName}/domain`, readOnly: true },
                  { name: `${appName}-cert-vol`, mountPath: `/mnt/${appName}/cert`, readOnly: true },
                  { name: `${appName}-gitlabid-vol`, mountPath: `/mnt/${appName}/gitlab-id`, readOnly: true },
                  { name: `${appName}-gitlabsecret-vol`, mountPath: `/mnt/${appName}/gitlab-secret`, readOnly: true },
                  { name: `${appName}-grafana-vol`, mountPath: `/mnt/${appName}/grafana`, readOnly: true },
                  { name: `${appName}-docdb-vol`, mountPath: `/mnt/${appName}/docdb`, readOnly: true }
                ]
              }
            ]
          }
        }
      }
    });

    const makeService = (appName: string, port: number) => ({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: appName, namespace },
      spec: {
        selector: { app: appName },
        ports: [{ port, targetPort: port }],
        type: 'ClusterIP'
      }
    });

    // Deploy Legend services. Pin to specific versions for production.
    const components = [
      { name: 'legend-engine',      image: 'finos/legend-engine-server:latest',       port: 6300 },
      { name: 'legend-sdlc',        image: 'finos/legend-sdlc-server:latest',         port: 6100 },
      { name: 'legend-studio',      image: 'finos/legend-studio:latest',              port: 9000 },
      { name: 'legend-query',       image: 'finos/legend-query:latest',               port: 9001 },
      { name: 'legend-pure-ide',    image: 'finos/legend-engine-pure-ide-light:latest', port: 9200 },
      { name: 'legend-depot',       image: 'finos/legend-depot-server:latest',        port: 6200 },
      { name: 'legend-depot-store', image: 'finos/legend-depot-store-server:latest',  port: 6201 }
    ];

    for (const comp of components) {
      const dplManifest = cluster.addManifest(`${comp.name}-deploy`, makeDeployment(comp.name, comp.image, comp.port));
      const svcManifest = cluster.addManifest(`${comp.name}-svc`, makeService(comp.name, comp.port));
      // Ensure namespace + all SPCs exist first
      dplManifest.node.addDependency(ns, domainSpc, certSpc, gitlabIdSpc, gitlabSecretSpc, grafanaSpc, docdbSpc);
      svcManifest.node.addDependency(dplManifest);
    }

    // Ingress referencing each service by path
    const ingress = cluster.addManifest('LegendIngress', {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: {
        name: 'legend-ingress',
        namespace,
        annotations: {
          'kubernetes.io/ingress.class': 'alb',
          'alb.ingress.kubernetes.io/scheme': 'internet-facing',
          'alb.ingress.kubernetes.io/listen-ports': '[{"HTTP":80,"HTTPS":443}]',
          // We'll retrieve the cert ARN from the "legend-certificate-secret" K8s secret if we wanted dynamic assignment.
          // Typically, ALB ingress needs a static annotation with the actual ARN. So you'd update it out-of-band or through automation.
          'alb.ingress.kubernetes.io/certificate-arn': '{{REPLACE_WITH_YOUR_CERT_ARN}}', 
          // or you can pass the real string if you retrieve the secret with CDK and override. 
          'alb.ingress.kubernetes.io/ssl-redirect': '443'
        }
      },
      spec: {
        rules: [
          {
            host: '{{REPLACE_WITH_DOMAIN_NAME}}', // Ensure to replace with domain name
            http: {
              paths: [
                { path: '/engine/*', pathType: 'Prefix', backend: { service: { name: 'legend-engine', port: { number: 6300 } } } },
                { path: '/sdlc/*',   pathType: 'Prefix', backend: { service: { name: 'legend-sdlc',   port: { number: 6100 } } } },
                { path: '/studio/*', pathType: 'Prefix', backend: { service: { name: 'legend-studio', port: { number: 9000 } } } },
                { path: '/query/*',  pathType: 'Prefix', backend: { service: { name: 'legend-query',  port: { number: 9001 } } } },
                { path: '/ide/*',    pathType: 'Prefix', backend: { service: { name: 'legend-pure-ide', port: { number: 9200 } } } },
                { path: '/depot/*',  pathType: 'Prefix', backend: { service: { name: 'legend-depot',  port: { number: 6200 } } } },
                { path: '/depot-store/*', pathType: 'Prefix', backend: { service: { name: 'legend-depot-store', port: { number: 6201 } } } }
              ]
            }
          }
        ]
      }
    });

    // Lock down traffic to legend namespace pods (optional)
    const networkPolicy = cluster.addManifest('LegendNetworkPolicy', {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: 'legend-deny-all-except-alb',
        namespace
      },
      spec: {
        podSelector: {},
        policyTypes: ['Ingress'],
        ingress: [
          {
            from: [
              // Typically you'd specify ALB security group or VPC subnets.
              // For simplicity, allow from entire VPC:
              { ipBlock: { cidr: vpc.vpcCidrBlock } }
            ]
          }
        ]
      }
    });
    networkPolicy.node.addDependency(ingress);
  }

  /**
   * Creates a separate SecretProviderClass referencing a single Secrets Manager secret.
   * This ensures each secret is fetched independently—no JSON lumps.
   * The "property" is optional if the secret itself is a raw string.
   * 
   * By default, we sync that string to a key named "KEY_NAME" in the resulting K8s Opaque Secret.
   */
  private createSecretProviderClass(
    cluster: eks.Cluster,
    idSuffix: string,
    namespace: string,
    secretArn: string,
    k8sSecretName: string,
    k8sSecretKey: string,
    secretProperty?: string,
    alternateProperty?: string,
    alternateKey?: string
  ): eks.KubernetesManifest {
    // If the secret is just a raw string (not JSON), you don't need property-based JMESPath.
    // If it's a generatedSecretString with a 'value' field, you can set property='value'.
    // For docdb secret, property might be 'password', 'username', etc.
    // We'll assume 'secretProperty' if provided, else take the entire secret as a single string.

    const jmesPath = secretProperty
      ? [{ path: secretProperty, objectAlias: k8sSecretKey }]
      : [{ path: '.', objectAlias: k8sSecretKey }]; // '.' means the entire secret

    if (alternateProperty && alternateKey) {
      // For docdb, we might want two fields: user + password from the same secret.
      jmesPath.push({ path: alternateProperty, objectAlias: alternateKey });
    }

    const spcDef = {
      apiVersion: 'secrets-store.csi.x-k8s.io/v1',
      kind: 'SecretProviderClass',
      metadata: { name: idSuffix, namespace },
      spec: {
        provider: 'aws',
        parameters: {
          objects: JSON.stringify([
            {
              objectName: secretArn,
              objectType: 'secretsmanager',
              jmesPath
            }
          ])
        },
        secretObjects: [
          {
            secretName: k8sSecretName,
            type: 'Opaque',
            data: jmesPath.map(mp => ({
              objectName: mp.objectAlias,
              key: mp.objectAlias
            }))
          }
        ]
      }
    };

    return cluster.addManifest(`SecretProviderClass-${idSuffix}`, spcDef);
  }
}
