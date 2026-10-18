import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { buildApp } from './testing.js';

// Builds the whole app, including the worker's Docker context, so allow it time on a busy machine.
const SYNTH_TIMEOUT_MS = 60_000;

function allTemplates(): Template[] {
  const built = buildApp(undefined, { routes: true, worker: true, budget: true, monitoring: true });
  return [
    ...Object.values(built.templates),
    ...[built.worker, built.budget, built.monitoring].map((s) =>
      Template.fromStack(s as NonNullable<typeof s>),
    ),
  ];
}

const resourceTypes = (templates: Template[]) =>
  templates.flatMap((t) =>
    Object.values(t.toJSON().Resources as Record<string, { Type: string }>).map((r) => r.Type),
  );

describe('nothing in the app has a fixed monthly cost beyond the few listed in the summary', () => {
  it(
    'has no NAT gateway, VPC endpoint, Elastic IP, CloudFront, load balancer, WAF, database, KMS key or hosted zone',
    () => {
      const forbidden = [
        /^AWS::EC2::(NatGateway|VPCEndpoint|EIP|VPNGateway|TransitGateway)/,
        /^AWS::CloudFront::/,
        /^AWS::ElasticLoadBalancing(V2)?::/,
        /^AWS::WAF(v2|Regional)?::/,
        /^AWS::(RDS|DocDB|Neptune|Redshift|ElastiCache|OpenSearchService|Elasticsearch)::/,
        /^AWS::KMS::Key$/,
        /^AWS::Route53::/,
      ];
      const types = resourceTypes(allTemplates());
      for (const pattern of forbidden) {
        expect(
          types.filter((t) => pattern.test(t)),
          String(pattern),
        ).toEqual([]);
      }
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    'bills every DynamoDB table per request, with no provisioned throughput',
    () => {
      for (const template of allTemplates()) {
        for (const table of Object.values(template.findResources('AWS::DynamoDB::Table'))) {
          expect(table.Properties.BillingMode).toBe('PAY_PER_REQUEST');
          expect(table.Properties).not.toHaveProperty('ProvisionedThroughput');
        }
      }
    },
    SYNTH_TIMEOUT_MS,
  );

  it(
    'has exactly one Secrets Manager secret (the other, the Google OAuth secret, is made by hand)',
    () => {
      const types = resourceTypes(allTemplates());
      expect(types.filter((t) => t === 'AWS::SecretsManager::Secret')).toHaveLength(1);
    },
    SYNTH_TIMEOUT_MS,
  );
});

describe('.gitignore', () => {
  const ignore = readFileSync(fileURLToPath(new URL('../../.gitignore', import.meta.url)), 'utf8')
    .split('\n')
    .map((line) => line.trim());

  it.each(['.env', '.env.*', 'cdk.out/', 'infra/cdk.context.json', 'transcription-compare-*.csv'])(
    'ignores %s',
    (entry) => {
      expect(ignore).toContain(entry);
    },
  );
});
