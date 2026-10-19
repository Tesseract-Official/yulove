import { Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../testing.js';
import { GOOGLE_OAUTH_SECRET_NAME } from './auth-stack.js';

const template = buildApp().templates.auth;

describe('AuthStack', () => {
  it('uses Google as the identity provider, with credentials from Secrets Manager', () => {
    expect(GOOGLE_OAUTH_SECRET_NAME).toBe('dsa-judge/google-oauth');
    template.hasResourceProperties('AWS::Cognito::UserPoolIdentityProvider', {
      ProviderType: 'Google',
      ProviderDetails: {
        client_id: '{{resolve:secretsmanager:dsa-judge/google-oauth:SecretString:clientId::}}',
        client_secret:
          '{{resolve:secretsmanager:dsa-judge/google-oauth:SecretString:clientSecret::}}',
      },
    });
  });

  it('has a hosted UI domain', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
  });

  it('has a secretless SPA client using the authorization code flow and the web origin', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthFlowsUserPoolClient: true,
      SupportedIdentityProviders: ['Google'],
      CallbackURLs: ['https://app.college.edu/auth/callback'],
      LogoutURLs: ['https://app.college.edu/'],
    });
  });

  it('lets the web app renew tokens with a refresh token that lasts one day', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      // The refresh_token grant is the only auth flow switched on.
      ExplicitAuthFlows: ['ALLOW_REFRESH_TOKEN_AUTH'],
      RefreshTokenValidity: 1440,
      IdTokenValidity: 60,
      AccessTokenValidity: 60,
      TokenValidityUnits: { RefreshToken: 'minutes', IdToken: 'minutes', AccessToken: 'minutes' },
      EnableTokenRevocation: true,
    });
  });

  it('runs a Node.js 22 pre-sign-up Lambda configured for the college domain and Users table, and no founder list', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Environment: {
        Variables: Match.objectLike({
          COLLEGE_DOMAIN: 'college.edu',
          USERS_TABLE: Match.anyValue(),
        }),
      },
    });
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      LambdaConfig: { PreSignUp: Match.anyValue() },
    });
    // Who may sign in comes from the Users table (the role decides), not from a list in the Lambda.
    expect(JSON.stringify(template.toJSON())).not.toContain('SUPER_ADMIN_EMAILS');
  });

  it('lets the pre-sign-up Lambda read the Users table and nothing else', () => {
    const policies = Object.values(template.findResources('AWS::IAM::Policy'));
    const statements = policies.flatMap(
      (p) => p.Properties.PolicyDocument.Statement as { Action: string | string[] }[],
    );
    const actions = statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(actions).toContain('dynamodb:GetItem');
    expect(actions.filter((a) => /PutItem|UpdateItem|DeleteItem/.test(a))).toEqual([]);
  });
});
