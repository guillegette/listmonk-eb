# Listmonk in AWS Elastic Beanstalk

This project provides an [AWS CDK](https://docs.aws.amazon.com/cdk/latest/guide/home.html) stack to deploy [listmonk](https://listmonk.app/) — a high performance self-hosted mailing list and campaign manager — on **AWS Elastic Beanstalk** with an **Aurora PostgreSQL Serverless v2** backend.

The stack provisions:
- VPC with public and private subnets
- Security groups for ALB, EB instances, and Aurora DB
- Aurora PostgreSQL Serverless v2 cluster with Secrets Manager
- Elastic Beanstalk environment (ALB + EC2 instances) running listmonk Docker image
- HTTPS listener with your ACM certificate
- Rolling deployments and managed platform updates

---

## Prerequisites

- Node.js 18+ with [nvm](https://github.com/nvm-sh/nvm)
- AWS CLI configured
- [AWS CDK v2](https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html) installed
- An ACM certificate in **us-east-1** (required by EB ALB)

---

## Quick Start

1. **Clone the repo**

   ```bash
   git clone https://github.com/guillegette/listmonk-eb.git
   cd listmonk-cdk
   ```
1. **Install dependencies**

   ```bash
   npm install
   ```
3. **Bootstrap CDK (only once per account/region)**

   ```bash
   cdk bootstrap --region us-east-1 --profile your-profile
   ```
4. **Deploy**
   
   ```bash
   npx cdk deploy ListmonkEbStack \
    --parameters ListmonkEbStack:AcmCertArn=arn:aws:acm:us-east-1:<account-id>:certificate/<your-cert-id> \
    --parameters ListmonkEbStack:ListmonkImageTag=v5.0.3 \
    --require-approval never \
    --region us-east-1 --profile your-profile
   ```

## Outputs

On successful deploy, CDK will print:

- VpcId – VPC id
- AppSgId – EB instance security group
- DbEndpoint – Aurora cluster endpoint
- DbSecretArn – ARN of the DB secret in Secrets Manager

## Customization

- Instance size: default is t3.medium. Change in listmonk-eb-stack.js.
- Aurora capacity: default serverless v2 range is 0.5–8 ACUs. Adjust serverlessV2MinCapacity and serverlessV2MaxCapacity.
- Time zone: environment variable TZ. Update if needed.
- Managed updates: set PreferredStartTime to control when EB applies platform updates.
