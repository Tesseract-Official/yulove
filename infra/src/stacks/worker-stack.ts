import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import {
  GatewayVpcEndpointAwsService,
  InterfaceVpcEndpointAwsService,
  SubnetType,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import {
  Cluster,
  ContainerImage,
  CpuArchitecture,
  FargateService,
  FargateTaskDefinition,
  LogDrivers,
  OperatingSystemFamily,
} from 'aws-cdk-lib/aws-ecs';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Bucket } from 'aws-cdk-lib/aws-s3';
import type { Queue } from 'aws-cdk-lib/aws-sqs';
import { BUCKET_ENV, QUEUE_ENV } from '@yulove/shared';
import type { Construct } from 'constructs';
import { WORKER_DIR } from '../lib/handler-paths.js';

export interface WorkerStackProps extends StackProps {
  executeQueue: Queue;
  resultsQueue: Queue;
  bucket: Bucket;
}

/** Jobs the worker runs at once. 4 vCPU, and DESIGN.md says one job per vCPU. */
export const WORKER_CONCURRENCY = 4;

/**
 * The execution worker (docs/DESIGN.md, "Code execution worker"): one Fargate task in a VPC that
 * has no route to the internet. It reaches AWS only through VPC endpoints.
 */
export class WorkerStack extends Stack {
  readonly vpc: Vpc;
  readonly taskDefinition: FargateTaskDefinition;
  readonly service: FargateService;

  constructor(scope: Construct, id: string, props: WorkerStackProps) {
    super(scope, id, props);

    // Isolated subnets only: no public subnets, so no internet gateway, and no NAT gateway.
    this.vpc = new Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'isolated', subnetType: SubnetType.PRIVATE_ISOLATED }],
    });

    // What the task and the Fargate agent need: queues, logs, and the image (ECR, whose layers
    // live in S3).
    this.vpc.addInterfaceEndpoint('SqsEndpoint', { service: InterfaceVpcEndpointAwsService.SQS });
    this.vpc.addInterfaceEndpoint('LogsEndpoint', {
      service: InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
    });
    this.vpc.addInterfaceEndpoint('EcrApiEndpoint', {
      service: InterfaceVpcEndpointAwsService.ECR,
    });
    this.vpc.addInterfaceEndpoint('EcrDockerEndpoint', {
      service: InterfaceVpcEndpointAwsService.ECR_DOCKER,
    });
    this.vpc.addGatewayEndpoint('S3Endpoint', { service: GatewayVpcEndpointAwsService.S3 });

    const cluster = new Cluster(this, 'Cluster', { vpc: this.vpc });

    this.taskDefinition = new FargateTaskDefinition(this, 'TaskDefinition', {
      cpu: 4096,
      memoryLimitMiB: 8192,
      runtimePlatform: {
        operatingSystemFamily: OperatingSystemFamily.LINUX,
        cpuArchitecture: CpuArchitecture.X86_64,
      },
      // Fargate's ephemeral storage, mounted at /work for the per-run directories.
      volumes: [{ name: 'work' }],
    });

    const image = new DockerImageAsset(this, 'WorkerImage', {
      directory: WORKER_DIR,
      platform: Platform.LINUX_AMD64,
      target: 'production',
    });

    const logGroup = new LogGroup(this, 'LogGroup', {
      retention: RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const container = this.taskDefinition.addContainer('Worker', {
      image: ContainerImage.fromDockerImageAsset(image),
      // The root filesystem is read-only; the only place programs can write is their own
      // directory under /work. The default Linux capabilities are kept: the worker needs setuid,
      // setgid and kill to start jobs as runner users and to stop them.
      readonlyRootFilesystem: true,
      // Let jobs finish after SIGTERM (Fargate allows at most 120 seconds).
      stopTimeout: Duration.seconds(120),
      logging: LogDrivers.awsLogs({ streamPrefix: 'worker', logGroup }),
      environment: {
        [QUEUE_ENV.execute]: props.executeQueue.queueUrl,
        [QUEUE_ENV.results]: props.resultsQueue.queueUrl,
        [BUCKET_ENV]: props.bucket.bucketName,
        WORKER_CONCURRENCY: String(WORKER_CONCURRENCY),
      },
    });
    container.addMountPoints({ containerPath: '/work', sourceVolume: 'work', readOnly: false });

    // The task role: exactly what the worker does, and no database access at all (so a program
    // that escaped its sandbox still could not touch scores).
    this.taskDefinition.addToTaskRolePolicy(
      new PolicyStatement({
        actions: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility'],
        resources: [props.executeQueue.queueArn],
      }),
    );
    this.taskDefinition.addToTaskRolePolicy(
      new PolicyStatement({
        actions: ['sqs:SendMessage'],
        resources: [props.resultsQueue.queueArn],
      }),
    );
    this.taskDefinition.addToTaskRolePolicy(
      new PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [props.bucket.arnForObjects('questions/*')],
      }),
    );
    this.taskDefinition.addToTaskRolePolicy(
      new PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [props.bucket.arnForObjects('questions/*/tests.json')],
      }),
    );

    this.service = new FargateService(this, 'Service', {
      cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
      // Start the new task before stopping the old one when deploying.
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true },
    });
  }
}
