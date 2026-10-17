import { Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../testing.js';

const { hosting, templates } = buildApp();
const template = templates.hosting;

describe('WebHostingStack bucket', () => {
  it('is private: every kind of public access is blocked', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('is not an S3 website', () => {
    for (const bucket of Object.values(template.findResources('AWS::S3::Bucket'))) {
      expect(bucket.Properties).not.toHaveProperty('WebsiteConfiguration');
    }
  });

  it('is encrypted, retained, and refuses plain HTTP', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: Match.objectLike({
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      }),
    });
    for (const bucket of Object.values(template.findResources('AWS::S3::Bucket'))) {
      expect(bucket['DeletionPolicy']).toBe('Retain');
    }
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  it('can be read by this CloudFront distribution and nobody else', () => {
    const policies = Object.values(template.findResources('AWS::S3::BucketPolicy'));
    const allows = policies.flatMap((policy) =>
      (policy.Properties.PolicyDocument.Statement as Record<string, unknown>[]).filter(
        (statement) => statement['Effect'] === 'Allow',
      ),
    );

    expect(allows).toHaveLength(1);
    const [allow] = allows as [
      {
        Principal: unknown;
        Action: unknown;
        Condition: { StringEquals: Record<string, unknown> };
      },
    ];
    expect(allow.Principal).toEqual({ Service: 'cloudfront.amazonaws.com' });
    expect(allow.Action).toBe('s3:GetObject');
    // Limited to this one distribution.
    expect(JSON.stringify(allow.Condition.StringEquals['AWS:SourceArn'])).toContain(
      ':distribution/',
    );
    expect(JSON.stringify(allows)).not.toContain('"*"');
  });
});

describe('WebHostingStack distribution', () => {
  it('reads the bucket through origin access control, not an identity or a website endpoint', () => {
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.resourceCountIs('AWS::CloudFront::CloudFrontOriginAccessIdentity', 0);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        Origins: [
          Match.objectLike({
            OriginAccessControlId: Match.anyValue(),
            S3OriginConfig: { OriginAccessIdentity: '' },
          }),
        ],
      },
    });
  });

  it('is HTTPS only: HTTP requests are redirected', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
      },
    });
  });

  it('serves index.html at the root and for paths that are not files (SPA fallback)', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        CustomErrorResponses: [
          Match.objectLike({ ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/index.html' }),
          Match.objectLike({ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html' }),
        ],
      }),
    });
  });

  it('adds security headers', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultCacheBehavior: Match.objectLike({ ResponseHeadersPolicyId: Match.anyValue() }),
      },
    });
  });

  it('outputs the site URL', () => {
    const outputs = template.findOutputs('SiteUrl');
    expect(Object.keys(outputs)).toEqual(['SiteUrl']);
    expect(JSON.stringify(outputs['SiteUrl']?.Value)).toContain('https://');
    expect(hosting.siteUrl).toMatch(/^\$\{Token\[.*\]\}$|^https:\/\//);
  });
});
