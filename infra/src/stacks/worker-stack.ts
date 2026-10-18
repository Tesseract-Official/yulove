import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { SecurityGroup, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import {
  AdjustmentType,
  MetricAggregationType,
  ScalableTarget,
  ServiceNamespace,
  StepScalingAction,
} from 'aws-cdk-lib/aws-applicationautoscaling';
import {
  Alarm,
  ComparisonOperator,
  MathExpression,
  TreatMissingData,
} from 'aws-cdk-lib/aws-cloudwatch';
import { ApplicationScalingAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
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
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import type { Bucket } from 'aws-cdk-lib/aws-s3';
import type { Queue } from 'aws-cdk-lib/aws-sqs';
import { BUCKET_ENV, QUEUE_ENV } from '@yulove/shared';
import type { Construct } from 'constructs';
import { WORKER_DIR } from '../lib/handler-paths.js';
import { LOG_RETENTION } from '../lib/node-function.js';

export interface WorkerStackProps extends StackProps {
  executeQueue: Queue;
  resultsQueue: Queue;
  bucket: Bucket;
}

/** Jobs the worker runs at once. 4 vCPU, and DESIGN.md says one job per vCPU. */
export const WORKER_CONCURRENCY = 4;

/** The worker is off when there is nothing to do: 0 tasks, or 1 while the queue has work. */
export const MIN_TASKS = 0;
export const MAX_TASKS = 1;

/** The worker is switched off after the execute queue has been completely empty this long. */
export const SCALE_IN_AFTER_EMPTY_MINUTES = 15;

/**
 * The execution worker (docs/DESIGN.md, "Code execution worker"): one Fargate task in a public
 * subnet with a public IP, no NAT gateway and no VPC endpoints, so nothing here costs money while
 * the worker is scaled to zero. The security group allows no inbound traffic.
 */
export class WorkerStack extends Stack {
  readonly vpc: Vpc;
  readonly securityGroup: SecurityGroup;
  readonly taskDefinition: FargateTaskDefinition;
  readonly service: FargateService;

  constructor(scope: Construct, id: string, props: WorkerStackProps) {
    super(scope, id, props);

    // Public subnet only (one zone is enough for one task): the task reaches SQS, S3, ECR and
    // CloudWatch Logs over the internet gateway through its public IP.
    this.vpc = new Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: SubnetType.PUBLIC }],
    });

    // Nothing may connect in (no ingress rule is ever added); the task only makes outbound calls.
    this.securityGroup = new SecurityGroup(this, 'TaskSecurityGroup', {
      vpc: this.vpc,
      description: 'Execution worker task: no inbound traffic, all outbound',
      allowAllOutbound: true,
    });

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
      retention: LOG_RETENTION,
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
      // Starts switched off; the queue alarms below turn it on when work arrives.
      desiredCount: MIN_TASKS,
      assignPublicIp: true,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      securityGroups: [this.securityGroup],
      // Start the new task before stopping the old one when deploying.
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true },
    });

    this.addQueueScaling(props.executeQueue);
  }

  /**
   * Scale to zero. A task starts when a message is waiting and stops after the queue has been
   * empty (nothing waiting and nothing being processed) for 15 minutes. The worker finishes the
   * jobs it has on SIGTERM, and the 15 empty minutes mean nothing is running when it stops.
   */
  private addQueueScaling(executeQueue: Queue): void {
    const target = new ScalableTarget(this, 'ScalableTarget', {
      serviceNamespace: ServiceNamespace.ECS,
      scalableDimension: 'ecs:service:DesiredCount',
      resourceId: `service/${this.service.cluster.clusterName}/${this.service.serviceName}`,
      minCapacity: MIN_TASKS,
      maxCapacity: MAX_TASKS,
    });

    const oneMinute = Duration.minutes(1);
    const waiting = executeQueue.metricApproximateNumberOfMessagesVisible({
      period: oneMinute,
      statistic: 'Maximum',
    });
    const beingProcessed = executeQueue.metricApproximateNumberOfMessagesNotVisible({
      period: oneMinute,
      statistic: 'Maximum',
    });
    const outstanding = new MathExpression({
      expression: 'waiting + beingProcessed',
      usingMetrics: { waiting, beingProcessed },
      period: oneMinute,
      label: 'Messages waiting or being processed',
    });

    // Scale out: set the task count to 1 as soon as a message is waiting.
    const scaleOut = new StepScalingAction(this, 'ScaleOut', {
      scalingTarget: target,
      adjustmentType: AdjustmentType.EXACT_CAPACITY,
      metricAggregationType: MetricAggregationType.MAXIMUM,
      cooldown: oneMinute,
    });
    scaleOut.addAdjustment({ adjustment: MAX_TASKS, lowerBound: 0 });
    new Alarm(this, 'QueueHasWorkAlarm', {
      alarmName: 'dsa-judge-worker-queue-has-work',
      alarmDescription: 'A message is waiting on the execute queue: start the worker.',
      metric: waiting,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      threshold: 0,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new ApplicationScalingAction(scaleOut));

    // Scale in: set the task count to 0 after 15 minutes in a row with nothing waiting and
    // nothing running. A minute with no data does not count as empty.
    const scaleIn = new StepScalingAction(this, 'ScaleIn', {
      scalingTarget: target,
      adjustmentType: AdjustmentType.EXACT_CAPACITY,
      metricAggregationType: MetricAggregationType.MAXIMUM,
      cooldown: oneMinute,
    });
    scaleIn.addAdjustment({ adjustment: MIN_TASKS, upperBound: 0 });
    new Alarm(this, 'QueueIdleAlarm', {
      alarmName: 'dsa-judge-worker-queue-idle',
      alarmDescription: `The execute queue has been empty for ${SCALE_IN_AFTER_EMPTY_MINUTES} minutes: stop the worker.`,
      metric: outstanding,
      comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
      threshold: 1, // fewer than 1 message = none
      evaluationPeriods: SCALE_IN_AFTER_EMPTY_MINUTES,
      datapointsToAlarm: SCALE_IN_AFTER_EMPTY_MINUTES,
      treatMissingData: TreatMissingData.MISSING,
    }).addAlarmAction(new ApplicationScalingAction(scaleIn));
  }
}
