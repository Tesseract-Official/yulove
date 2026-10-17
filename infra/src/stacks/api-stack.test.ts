import { Match } from 'aws-cdk-lib/assertions';
import { HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { describe, expect, it } from 'vitest';
import { serviceEntry } from '../lib/handler-paths.js';
import { buildApp } from '../testing.js';
import { assetCopyCommands } from './api-stack.js';

const ENTRY = serviceEntry('api/src/handlers/pre-sign-up.ts');

describe('ApiStack without routes', () => {
  const { templates } = buildApp();
  const template = templates.api;

  it('is an HTTP API limited to the web origin by CORS', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      ProtocolType: 'HTTP',
      CorsConfiguration: Match.objectLike({ AllowOrigins: ['https://app.college.edu'] }),
    });
  });

  it('outputs its URL for the web app config', () => {
    expect(Object.keys(template.findOutputs('ApiUrl'))).toEqual(['ApiUrl']);
  });

  it('has no routes yet', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Route', 0);
  });
});

describe('ApiStack.addRoute', () => {
  it('adds a JWT-protected route with a Node.js 22 Lambda', () => {
    const { api, templates } = buildApp();
    api.addRoute(HttpMethod.GET, '/me', ENTRY, { tables: { Users: 'read' } });
    const template = templates.api;

    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'GET /me',
      AuthorizationType: 'JWT',
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Environment: { Variables: Match.objectLike({ USERS_TABLE: Match.anyValue() }) },
    });
  });

  it('protects routes with a JWT authorizer backed by the Cognito user pool client', () => {
    const { api, templates } = buildApp();
    api.addRoute(HttpMethod.GET, '/me', ENTRY);
    const template = templates.api;

    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
      IdentitySource: ['$request.header.Authorization'],
      JwtConfiguration: {
        Issuer: Match.anyValue(),
        Audience: [Match.anyValue()],
      },
    });
  });

  it('grants only what the permissions list', () => {
    const { api, templates } = buildApp();
    api.addRoute(HttpMethod.POST, '/answers/submit', ENTRY, {
      tables: { Answers: 'readWrite', Users: 'read' },
      queues: { transcribe: 'send' },
      bucket: 'read',
    });
    const template = templates.api;

    const policy = JSON.stringify(
      Object.values(template.findResources('AWS::IAM::Policy')).map(
        (p) => p.Properties.PolicyDocument,
      ),
    );
    expect(policy).toContain('dynamodb:PutItem'); // Answers readWrite
    expect(policy).toContain('sqs:SendMessage');
    expect(policy).toContain('s3:GetObject');
    expect(policy).not.toContain('s3:PutObject'); // bucket is read-only
    expect(policy).not.toContain('sqs:ReceiveMessage');

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          ANSWERS_TABLE: Match.anyValue(),
          USERS_TABLE: Match.anyValue(),
          TRANSCRIBE_QUEUE_URL: Match.anyValue(),
          BUCKET_NAME: Match.anyValue(),
        }),
      },
    });
  });

  it('grants only PutItem on the audit log when no permissions are given', () => {
    const { api, templates } = buildApp();
    api.addRoute(HttpMethod.GET, '/health', ENTRY);
    const template = templates.api;

    const policies = Object.values(template.findResources('AWS::IAM::Policy'));
    expect(policies).toHaveLength(1);
    expect(policies[0]?.Properties.PolicyDocument.Statement).toEqual([
      { Action: 'dynamodb:PutItem', Effect: 'Allow', Resource: expect.anything() },
    ]);
    const fn = Object.values(template.findResources('AWS::Lambda::Function'))[0];
    const vars = (fn?.Properties.Environment?.Variables ?? {}) as Record<string, string>;
    expect(Object.keys(vars).filter((k) => /TABLE|QUEUE|BUCKET/.test(k))).toEqual([
      'AUDIT_LOG_TABLE',
    ]);
  });
});

describe('assetCopyCommands', () => {
  it('copies each folder next to the bundle', () => {
    expect(
      assetCopyCommands([{ from: 'services/api/assets/fonts', to: 'fonts' }], '/repo', '/out'),
    ).toEqual(['mkdir -p "/out/fonts" && cp -r "/repo/services/api/assets/fonts/." "/out/fonts/"']);
  });

  it('does nothing for no assets', () => {
    expect(assetCopyCommands([], '/repo', '/out')).toEqual([]);
  });
});
