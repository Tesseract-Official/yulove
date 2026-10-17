import { Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { TEST_CONTEXT, buildApp } from './testing.js';

// The web app is on Vercel: the only origins are the ones listed in cdk.json's `webOrigin`.
const ORIGINS = 'https://exam.vercel.app, http://localhost:5173';
const built = buildApp({ ...TEST_CONTEXT, webOrigin: ORIGINS }, { routes: true });
const { templates } = built;

describe('webOrigin', () => {
  it('sets the Cognito callback and logout URLs for every origin', () => {
    templates.auth.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: [
        'https://exam.vercel.app/auth/callback',
        'http://localhost:5173/auth/callback',
      ],
      LogoutURLs: ['https://exam.vercel.app/', 'http://localhost:5173/'],
    });
  });

  it('is the API CORS allow list', () => {
    templates.api.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowOrigins: ['https://exam.vercel.app', 'http://localhost:5173'],
      }),
    });
  });

  it('is the bucket CORS allow list', () => {
    templates.data.hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: {
        CorsRules: [
          Match.objectLike({
            AllowedOrigins: ['https://exam.vercel.app', 'http://localhost:5173'],
          }),
        ],
      },
    });
  });
});

describe('no CloudFront anywhere (CloudFront is blocked on the account)', () => {
  const cloudAssembly = built.app.synth();

  it('has no stack for hosting or deploying the web app', () => {
    const ids = cloudAssembly.stacks.map((stack) => stack.stackName);
    expect(ids.filter((id) => /web/i.test(id))).toEqual([]);
  });

  it('has no CloudFront resource in any stack', () => {
    for (const stack of cloudAssembly.stacks) {
      const types = Object.values(
        (stack.template as { Resources?: Record<string, { Type: string }> }).Resources ?? {},
      ).map((resource) => resource.Type);
      expect(
        types.filter((type) => type.startsWith('AWS::CloudFront')),
        stack.stackName,
      ).toEqual([]);
    }
  });
});
