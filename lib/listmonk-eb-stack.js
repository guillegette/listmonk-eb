'use strict';
const cdk = require('aws-cdk-lib');
const ec2 = require('aws-cdk-lib/aws-ec2');
const rds = require('aws-cdk-lib/aws-rds');
const secrets = require('aws-cdk-lib/aws-secretsmanager');
const iam = require('aws-cdk-lib/aws-iam');
const s3assets = require('aws-cdk-lib/aws-s3-assets');
const eb = require('aws-cdk-lib/aws-elasticbeanstalk');

class ListmonkEbStack extends cdk.Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    const prefix = 'listmonk';

    // VPC
    const vpc = new ec2.Vpc(this, `${prefix}-Vpc`, {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: `${prefix}-public`, subnetType: ec2.SubnetType.PUBLIC },
        { name: `${prefix}-private-egress`, subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      ],
    });

    // Security groups
    const appSg = new ec2.SecurityGroup(this, `${prefix}-AppSg`, {
      vpc,
      allowAllOutbound: true,
      description: `${prefix} EB instances`,
      securityGroupName: `${prefix}-app-sg`,
    });

    const lbSg = new ec2.SecurityGroup(this, `${prefix}-LbSg`, {
      vpc,
      allowAllOutbound: true,
      description: `${prefix} ALB`,
      securityGroupName: `${prefix}-alb-sg`,
    });
    // Internet -> ALB
    lbSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), `${prefix} HTTP`);
    lbSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), `${prefix} HTTPS`);
    // ALB -> EC2 (nginx on :80)
    appSg.addIngressRule(lbSg, ec2.Port.tcp(80), `${prefix} ALB to EC2:80`);

    const dbSg = new ec2.SecurityGroup(this, `${prefix}-DbSg`, {
      vpc,
      allowAllOutbound: true,
      description: `${prefix} Aurora PostgreSQL`,
      securityGroupName: `${prefix}-db-sg`,
    });
    dbSg.addIngressRule(appSg, ec2.Port.tcp(5432), `${prefix} App to Postgres`);

    // DB credentials secret
    const dbSecret = new secrets.Secret(this, `${prefix}-DbSecret`, {
      secretName: `${prefix}-db-secret`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'listmonk' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 24,
      },
    });

    // Aurora PostgreSQL Serverless v2
    const engine = rds.DatabaseClusterEngine.auroraPostgres({
      version: rds.AuroraPostgresEngineVersion.VER_15_3,
    });

    const cluster = new rds.DatabaseCluster(this, `${prefix}-AuroraPg`, {
      clusterIdentifier: `${prefix}-aurora-pg`,
      engine,
      credentials: rds.Credentials.fromSecret(dbSecret),
      defaultDatabaseName: 'listmonk',
      // Serverless v2 scaling
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 8,
      // Single writer
      instances: 1,
      instanceProps: {
        vpc,
        securityGroups: [dbSg],
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        publiclyAccessible: false,
      },
      storageEncrypted: true,
      deletionProtection: true,
      backup: { retention: cdk.Duration.days(7) },
    });

    cluster.connections.allowDefaultPortFrom(appSg, `${prefix} App access`);

    // Outputs
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
    new cdk.CfnOutput(this, 'AppSgId', { value: appSg.securityGroupId });
    new cdk.CfnOutput(this, 'DbEndpoint', { value: cluster.clusterEndpoint.hostname });
    new cdk.CfnOutput(this, 'DbSecretArn', { value: dbSecret.secretArn });

    // ---------- Parameters
    const acmArn = new cdk.CfnParameter(this, 'AcmCertArn', {
      type: 'String',
      description: 'ACM cert ARN in us-east-1 for the EB ALB HTTPS listener',
    });
    const listmonkImageTag = new cdk.CfnParameter(this, 'ListmonkImageTag', {
      type: 'String',
      default: 'v5.0.3',
      description: 'Docker image tag for listmonk/listmonk',
    });

    // ---------- Subnets for EB
    const privateSubnetIds = vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds;
    const publicSubnetIds  = vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).subnetIds;

    // ---------- EB Roles
    const ebServiceRole = new iam.Role(this, `${prefix}-EbServiceRole`, {
      assumedBy: new iam.ServicePrincipal('elasticbeanstalk.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSElasticBeanstalkEnhancedHealth'),
      ],
      roleName: `${prefix}-eb-service-role`,
    });

    const ebInstanceRole = new iam.Role(this, `${prefix}-EbEc2Role`, {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSElasticBeanstalkWebTier'),
      ],
      roleName: `${prefix}-eb-ec2-role`,
    });
    const ebInstanceProfile = new iam.CfnInstanceProfile(this, `${prefix}-EbInstanceProfile`, {
      roles: [ebInstanceRole.roleName],
    });

    // ---------- EB app bundle (points to ./eb-bundle)
    const bundle = new s3assets.Asset(this, `${prefix}-EbBundle`, {
      path: `${__dirname}/../eb-bundle`,
    });

    // ---------- EB Application + Version
    const ebApp = new eb.CfnApplication(this, `${prefix}-EbApp`, {
      applicationName: `${prefix}`,
    });
    const ebAppVersion = new eb.CfnApplicationVersion(this, `${prefix}-EbAppVersion`, {
      applicationName: ebApp.applicationName,
      sourceBundle: { s3Bucket: bundle.s3BucketName, s3Key: bundle.s3ObjectKey },
    });
    ebAppVersion.addDependency(ebApp);

    // ---------- EB Environment
    const solutionStackName = '64bit Amazon Linux 2023 v4.7.0 running Docker';

    const ebEnv = new eb.CfnEnvironment(this, `${prefix}-EbEnv`, {
      applicationName: ebApp.applicationName,
      environmentName: `${prefix}-prod`,
      solutionStackName,
      versionLabel: ebAppVersion.ref,
      optionSettings: [
        // Load balancer SG (ALBv2 namespace)
        { namespace: 'aws:elbv2:loadbalancer', optionName: 'SecurityGroups', value: lbSg.securityGroupId },

        // Roles
        { namespace: 'aws:elasticbeanstalk:environment', optionName: 'ServiceRole', value: ebServiceRole.roleArn },
        { namespace: 'aws:autoscaling:launchconfiguration', optionName: 'IamInstanceProfile', value: ebInstanceProfile.ref },
        { namespace: 'aws:autoscaling:launchconfiguration', optionName: 'SecurityGroups', value: appSg.securityGroupId },
        // Instance size (x86_64)
        { namespace: 'aws:autoscaling:launchconfiguration', optionName: 'InstanceType', value: 't3.medium' },

        // VPC wiring
        { namespace: 'aws:ec2:vpc', optionName: 'VPCId', value: vpc.vpcId },
        { namespace: 'aws:ec2:vpc', optionName: 'Subnets', value: privateSubnetIds.join(',') },
        { namespace: 'aws:ec2:vpc', optionName: 'ELBSubnets', value: publicSubnetIds.join(',') },

        // ALB + HTTPS
        { namespace: 'aws:elasticbeanstalk:environment', optionName: 'LoadBalancerType', value: 'application' },
        { namespace: 'aws:elb:listener:443', optionName: 'ListenerEnabled', value: 'true' },
        { namespace: 'aws:elb:listener:443', optionName: 'Protocol', value: 'HTTPS' },
        { namespace: 'aws:elb:listener:443', optionName: 'SSLCertificateId', value: acmArn.valueAsString },

        // Process/TG port & healthcheck (ALB hits :80; nginx proxies → container :9000)
        { namespace: 'aws:elasticbeanstalk:environment:process:default', optionName: 'Port', value: '80' },
        { namespace: 'aws:elasticbeanstalk:environment:process:default', optionName: 'HealthCheckPath', value: '/admin/login' },

        // App env vars (listmonk)
        { namespace: 'aws:elasticbeanstalk:application:environment', optionName: 'LISTMONK_IMAGE_TAG', value: listmonkImageTag.valueAsString },
        { namespace: 'aws:elasticbeanstalk:application:environment', optionName: 'LISTMONK_app__address', value: '0.0.0.0:9000' },
        { namespace: 'aws:elasticbeanstalk:application:environment', optionName: 'LISTMONK_db__host', value: cluster.clusterEndpoint.hostname },
        { namespace: 'aws:elasticbeanstalk:application:environment', optionName: 'LISTMONK_db__port', value: '5432' },
        { namespace: 'aws:elasticbeanstalk:application:environment', optionName: 'LISTMONK_db__database', value: 'listmonk' },
        { namespace: 'aws:elasticbeanstalk:application:environment', optionName: 'LISTMONK_db__user', value: dbSecret.secretValueFromJson('username').unsafeUnwrap().toString() },
        { namespace: 'aws:elasticbeanstalk:application:environment', optionName: 'LISTMONK_db__password', value: dbSecret.secretValueFromJson('password').unsafeUnwrap().toString() },
        { namespace: 'aws:elasticbeanstalk:application:environment', optionName: 'LISTMONK_db__ssl_mode', value: 'require' },
        { namespace: 'aws:elasticbeanstalk:application:environment', optionName: 'TZ', value: 'Australia/Sydney' },

        // Rolling deploys
        { namespace: 'aws:elasticbeanstalk:command', optionName: 'DeploymentPolicy', value: 'Rolling' },

        // Managed platform updates (enable; minor updates)
        { namespace: 'aws:elasticbeanstalk:managedactions', optionName: 'ManagedActionsEnabled', value: 'true' },
        { namespace: 'aws:elasticbeanstalk:managedactions:platformupdate', optionName: 'UpdateLevel', value: 'minor' },
        { namespace: 'aws:elasticbeanstalk:managedactions', optionName: 'PreferredStartTime', value: 'Sun:14:00' },
      ],
    });

    // allow EB service to read the uploaded bundle
    bundle.grantRead(new iam.ServicePrincipal('elasticbeanstalk.amazonaws.com'));
  }
}

module.exports = { ListmonkEbStack };