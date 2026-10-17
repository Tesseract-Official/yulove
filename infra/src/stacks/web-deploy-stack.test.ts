import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../testing.js';

const { app, webDeployTemplate } = buildApp(undefined, { webDeploy: true });
const template = webDeployTemplate();

describe('WebDeployStack', () => {
  it('uploads into the hosting bucket and clears the CloudFront cache', () => {
    template.hasResourceProperties('Custom::CDKBucketDeployment', {
      DestinationBucketName: Match.anyValue(),
      DistributionId: Match.anyValue(),
      DistributionPaths: ['/*'],
      Prune: true,
    });
  });

  it('never lets index.html or config.json go stale in a browser', () => {
    template.hasResourceProperties('Custom::CDKBucketDeployment', {
      SystemMetadata: Match.objectLike({ 'cache-control': 'no-cache' }),
    });
  });

  it('writes config.json at deploy time from the Auth and API stack values', () => {
    // The staged upload has the app's files and a config.json whose values are filled in at deploy.
    const { directory } = app.synth();
    const staged = readdirSync(directory)
      .map((name) => join(directory, name, 'config.json'))
      .filter((file) => existsSync(file));
    expect(staged).toHaveLength(1);
    const config = JSON.parse(
      readFileSync(staged[0]!, 'utf8').replace(/<<marker:[^>]*>>/g, '"x"'),
    ) as Record<string, string>;

    // The same keys web/src/config/config.ts requires.
    expect(Object.keys(config).sort()).toEqual(
      ['apiUrl', 'clientId', 'cognitoDomain', 'logoutUri', 'redirectUri'].sort(),
    );

    const [deployment] = Object.values(template.findResources('Custom::CDKBucketDeployment'));
    const values = JSON.stringify(deployment?.Properties.SourceMarkers);
    expect(values).toContain('/auth/callback');
    expect(values).toContain('ExportsOutputFnGetAttHttpApi'); // the API endpoint
    expect(values).toContain('amazoncognito.com'); // the hosted UI domain
    expect(values).toContain('ExportsOutputRefUserPoolSpaClient'); // the client id
    expect(values).toContain('WebHosting:ExportsOutputFnGetAttDistribution'); // the site URL
  });

  it('outputs the site URL', () => {
    expect(Object.keys(template.findOutputs('SiteUrl'))).toEqual(['SiteUrl']);
  });
});
