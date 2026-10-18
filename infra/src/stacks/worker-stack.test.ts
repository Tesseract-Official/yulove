import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../testing.js';
import { WORKER_CONCURRENCY } from './worker-stack.js';

const { app, worker } = buildApp(undefined, { worker: true });
if (!worker) throw new Error('The worker stack was not built');
const template = Template.fromStack(worker);

interface Statement {
  Effect: string;
  Action: string | string[];
  Resource: unknown;
}

const actionsOf = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);

/** The statements of the policy attached to the task role (not the execution role). */
function roleStatements(roleLogicalIdPattern: RegExp): Statement[] {
  return Object.entries(template.findResources('AWS::IAM::Policy'))
    .filter(([, policy]) =>
      (policy.Properties.Roles as Array<{ Ref: string }>).some((r) =>
        roleLogicalIdPattern.test(r.Ref),
      ),
    )
    .flatMap(([, policy]) => policy.Properties.PolicyDocument.Statement as Statement[]);
}

const taskStatements = () => roleStatements(/TaskRole/);
const executionStatements = () => roleStatements(/ExecutionRole/);

const resourceText = (s: Statement) => JSON.stringify(s.Resource);

describe('WorkerStack: network', () => {
  it('has no VPC endpoints of any kind', () => {
    template.resourceCountIs('AWS::EC2::VPCEndpoint', 0);
  });

  it('has no NAT gateway and no Elastic IP', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    template.resourceCountIs('AWS::EC2::EIP', 0);
  });

  it('has one public subnet with a route to an internet gateway', () => {
    const subnets = Object.values(template.findResources('AWS::EC2::Subnet'));
    expect(subnets).toHaveLength(1);
    expect(subnets[0]?.Properties.MapPublicIpOnLaunch).toBe(true);
    template.resourceCountIs('AWS::EC2::InternetGateway', 1);
    template.hasResourceProperties('AWS::EC2::Route', {
      DestinationCidrBlock: '0.0.0.0/0',
      GatewayId: Match.anyValue(),
    });
    for (const route of Object.values(template.findResources('AWS::EC2::Route'))) {
      expect(route.Properties).not.toHaveProperty('NatGatewayId');
    }
  });

  it('has a security group with no inbound rules and all outbound', () => {
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
    const groups = Object.values(template.findResources('AWS::EC2::SecurityGroup'));
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.Properties).not.toHaveProperty('SecurityGroupIngress');
    }
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupEgress: [{ CidrIp: '0.0.0.0/0', IpProtocol: '-1' }],
    });
  });

  it('runs the task in the public subnet with a public IP, in that security group', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 0,
      LaunchType: 'FARGATE',
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({
          AssignPublicIp: 'ENABLED',
          SecurityGroups: [
            { 'Fn::GetAtt': [Match.stringLikeRegexp('^TaskSecurityGroup'), 'GroupId'] },
          ],
        }),
      },
    });
  });
});

describe('WorkerStack: the task', () => {
  it('is Fargate with 4 vCPU and 8 GB on Linux X86_64', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      RequiresCompatibilities: ['FARGATE'],
      NetworkMode: 'awsvpc',
      Cpu: '4096',
      Memory: '8192',
      RuntimePlatform: { CpuArchitecture: 'X86_64', OperatingSystemFamily: 'LINUX' },
    });
  });

  it('has a read-only root filesystem and a /work volume it can write to', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Volumes: [{ Name: 'work' }],
      ContainerDefinitions: [
        Match.objectLike({
          ReadonlyRootFilesystem: true,
          MountPoints: [{ ContainerPath: '/work', SourceVolume: 'work', ReadOnly: false }],
        }),
      ],
    });
  });

  it('waits up to 120 seconds for jobs to finish after SIGTERM', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [Match.objectLike({ StopTimeout: 120 })],
    });
  });

  it('keeps the default Linux capabilities (setuid, setgid and kill are needed)', () => {
    const [definition] = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
    const container = definition?.Properties.ContainerDefinitions[0];
    expect(container.LinuxParameters?.Capabilities?.Drop).toBeUndefined();
    expect(container.LinuxParameters?.Capabilities?.Add).toBeUndefined();
    expect(container.Privileged).toBeUndefined();
    expect(container.User).toBeUndefined(); // runs as root, which the worker needs to start runners
  });

  it('is told where the queues and the bucket are, and how many jobs to run', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'EXECUTE_QUEUE_URL' }),
            Match.objectLike({ Name: 'RESULTS_QUEUE_URL' }),
            Match.objectLike({ Name: 'BUCKET_NAME' }),
            { Name: 'WORKER_CONCURRENCY', Value: String(WORKER_CONCURRENCY) },
          ]),
        }),
      ],
    });
    expect(WORKER_CONCURRENCY).toBe(4);
  });

  it('logs to CloudWatch, and keeps the logs if the stack is deleted', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });
    for (const group of Object.values(template.findResources('AWS::Logs::LogGroup'))) {
      expect(group.DeletionPolicy).toBe('Retain');
    }
  });

  it('starts switched off and replaces a task before stopping the old one', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 0,
      DeploymentConfiguration: Match.objectLike({
        MinimumHealthyPercent: 100,
        MaximumPercent: 200,
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      }),
    });
  });
});

describe('WorkerStack: scaling to zero', () => {
  const policies = () =>
    Object.entries(template.findResources('AWS::ApplicationAutoScaling::ScalingPolicy'));
  const alarms = () => Object.entries(template.findResources('AWS::CloudWatch::Alarm'));
  const policyNamed = (fragment: string) => {
    const found = policies().find(([id]) => id.includes(fragment));
    if (!found) throw new Error(`No scaling policy ${fragment}`);
    return found;
  };
  const alarmNamed = (name: string) => {
    const found = alarms().find(([, alarm]) => alarm.Properties.AlarmName === name);
    if (!found) throw new Error(`No alarm ${name}`);
    return found[1].Properties;
  };

  it('lets the ECS service run between 0 and 1 tasks', () => {
    template.resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', 1);
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
      MinCapacity: 0,
      MaxCapacity: 1,
      ScalableDimension: 'ecs:service:DesiredCount',
      ServiceNamespace: 'ecs',
    });
  });

  it('has exactly two scaling policies, both setting an exact task count', () => {
    expect(policies()).toHaveLength(2);
    for (const [, policy] of policies()) {
      expect(policy.Properties.PolicyType).toBe('StepScaling');
      expect(policy.Properties.StepScalingPolicyConfiguration.AdjustmentType).toBe('ExactCapacity');
    }
  });

  it('scales out to 1 task when a message is waiting', () => {
    const [outId, out] = policyNamed('ScaleOut');
    expect(out.Properties.StepScalingPolicyConfiguration.StepAdjustments).toEqual([
      { MetricIntervalLowerBound: 0, ScalingAdjustment: 1 },
    ]);

    const alarm = alarmNamed('dsa-judge-worker-queue-has-work');
    expect(alarm).toMatchObject({
      Namespace: 'AWS/SQS',
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Statistic: 'Maximum',
      Period: 60,
      ComparisonOperator: 'GreaterThanThreshold',
      Threshold: 0,
      EvaluationPeriods: 1,
      DatapointsToAlarm: 1,
      TreatMissingData: 'notBreaching',
    });
    expect(JSON.stringify(alarm.Dimensions)).toContain('executeQueue');
    expect(alarm.AlarmActions).toEqual([{ Ref: outId }]);
  });

  it('scales in to 0 tasks after 15 minutes in a row with nothing waiting or running', () => {
    const [inId, scaleIn] = policyNamed('ScaleIn');
    expect(scaleIn.Properties.StepScalingPolicyConfiguration.StepAdjustments).toEqual([
      { MetricIntervalUpperBound: 0, ScalingAdjustment: 0 },
    ]);

    const alarm = alarmNamed('dsa-judge-worker-queue-idle');
    expect(alarm).toMatchObject({
      ComparisonOperator: 'LessThanThreshold',
      Threshold: 1, // fewer than one message = none
      EvaluationPeriods: 15,
      DatapointsToAlarm: 15,
      TreatMissingData: 'missing',
    });
    expect(alarm.AlarmActions).toEqual([{ Ref: inId }]);
  });

  it('measures the idle queue as visible + not visible, with metric math', () => {
    const { Metrics: metrics } = alarmNamed('dsa-judge-worker-queue-idle') as {
      Metrics: Array<{
        Id: string;
        Expression?: string;
        ReturnData?: boolean;
        MetricStat?: {
          Metric: { MetricName: string; Namespace: string };
          Period: number;
          Stat: string;
        };
      }>;
    };

    const expression = metrics.find((m) => m.Expression);
    expect(expression?.Expression).toBe('waiting + beingProcessed');
    expect(expression?.ReturnData).not.toBe(false);

    const sources = metrics.filter((m) => m.MetricStat);
    expect(sources.map((m) => m.MetricStat?.Metric.MetricName).sort()).toEqual([
      'ApproximateNumberOfMessagesNotVisible',
      'ApproximateNumberOfMessagesVisible',
    ]);
    for (const source of sources) {
      expect(source.MetricStat?.Metric.Namespace).toBe('AWS/SQS');
      expect(source.MetricStat?.Period).toBe(60);
      expect(source.MetricStat?.Stat).toBe('Maximum');
      expect(source.ReturnData).toBe(false); // only the sum is evaluated
    }
    expect(sources.map((m) => m.Id).sort()).toEqual(['beingProcessed', 'waiting']);
  });

  it('has just those two alarms', () => {
    expect(alarms()).toHaveLength(2);
  });

  it('does not let the alarms touch anything but the worker service', () => {
    for (const [, alarm] of alarms()) {
      expect(alarm.Properties.AlarmActions).toHaveLength(1);
      expect(alarm.Properties.OKActions).toBeUndefined();
      expect(alarm.Properties.InsufficientDataActions).toBeUndefined();
    }
  });
});

describe('WorkerStack: the image', () => {
  it('is built from /worker for linux/amd64, targeting the production stage', () => {
    const assembly = app.synth();
    const manifest = JSON.parse(
      readFileSync(join(assembly.directory, 'Worker.assets.json'), 'utf8'),
    ) as {
      dockerImages: Record<
        string,
        { source: { directory: string; platform?: string; dockerBuildTarget?: string } }
      >;
    };
    const images = Object.values(manifest.dockerImages);

    expect(images).toHaveLength(1);
    expect(images[0]?.source.platform).toBe('linux/amd64');
    expect(images[0]?.source.dockerBuildTarget).toBe('production');
  });
});

describe('WorkerStack: the task role', () => {
  it('receives, deletes and changes visibility on the execute queue only', () => {
    const statement = taskStatements().find((s) =>
      actionsOf(s).some((a) => a.startsWith('sqs:Receive')),
    );
    expect(actionsOf(statement as Statement).sort()).toEqual([
      'sqs:ChangeMessageVisibility',
      'sqs:DeleteMessage',
      'sqs:ReceiveMessage',
    ]);
    expect(resourceText(statement as Statement)).toContain('executeQueue');
    expect(resourceText(statement as Statement)).not.toContain('resultsQueue');
  });

  it('sends to the results queue only', () => {
    const statement = taskStatements().find((s) => actionsOf(s).includes('sqs:SendMessage'));
    expect(actionsOf(statement as Statement)).toEqual(['sqs:SendMessage']);
    expect(resourceText(statement as Statement)).toContain('resultsQueue');
    expect(resourceText(statement as Statement)).not.toContain('executeQueue');
  });

  it('reads questions/* and writes only questions/*/tests.json', () => {
    const read = taskStatements().find((s) => actionsOf(s).includes('s3:GetObject'));
    const write = taskStatements().find((s) => actionsOf(s).includes('s3:PutObject'));

    expect(actionsOf(read as Statement)).toEqual(['s3:GetObject']);
    expect(resourceText(read as Statement)).toMatch(/\/questions\/\*"/);
    expect(resourceText(read as Statement)).not.toMatch(/answers|exams/);

    expect(actionsOf(write as Statement)).toEqual(['s3:PutObject']);
    expect(resourceText(write as Statement)).toContain('/questions/*/tests.json');
  });

  it('has exactly those four statements and nothing else', () => {
    const statements = taskStatements();
    expect(statements).toHaveLength(4);
    expect(statements.flatMap(actionsOf).sort()).toEqual([
      's3:GetObject',
      's3:PutObject',
      'sqs:ChangeMessageVisibility',
      'sqs:DeleteMessage',
      'sqs:ReceiveMessage',
      'sqs:SendMessage',
    ]);
    for (const s of statements) expect(s.Effect).toBe('Allow');
  });

  it('has no DynamoDB access at all, anywhere in the stack', () => {
    expect(JSON.stringify(template.toJSON())).not.toMatch(/dynamodb/i);
  });

  it('has no wildcard resource and no wildcard action', () => {
    for (const s of [...taskStatements(), ...executionStatements()].filter(
      (st) => !actionsOf(st).includes('ecr:GetAuthorizationToken'),
    )) {
      expect(resourceText(s)).not.toBe('"*"');
    }
    for (const s of taskStatements()) {
      for (const action of actionsOf(s)) expect(action).not.toMatch(/\*/);
    }
  });

  it('cannot use Secrets Manager, Lambda or any other service', () => {
    const services = new Set(
      taskStatements()
        .flatMap(actionsOf)
        .map((a) => a.split(':')[0]),
    );
    expect([...services].sort()).toEqual(['s3', 'sqs']);
  });
});

describe('WorkerStack: the execution role', () => {
  it('only pulls the image and writes logs (and has no data access)', () => {
    const services = new Set(
      executionStatements()
        .flatMap(actionsOf)
        .map((a) => a.split(':')[0]),
    );
    expect([...services].sort()).toEqual(['ecr', 'logs']);
  });
});
