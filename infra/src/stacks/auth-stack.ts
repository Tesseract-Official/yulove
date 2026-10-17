import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  SecretValue,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import {
  OAuthScope,
  ProviderAttribute,
  UserPool,
  UserPoolClient,
  UserPoolClientIdentityProvider,
  UserPoolDomain,
  UserPoolIdentityProviderGoogle,
} from 'aws-cdk-lib/aws-cognito';
import type { Table } from 'aws-cdk-lib/aws-dynamodb';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';
import { serviceEntry } from '../lib/handler-paths.js';
import { createNodeFunction } from '../lib/node-function.js';

/** Secrets Manager secret holding JSON {"clientId": "...", "clientSecret": "..."}; created by hand. */
export const GOOGLE_OAUTH_SECRET_NAME = 'dsa-judge/google-oauth';

/** How long the web app's tokens last. The API checks the ID token, so it is renewed hourly. */
export const ID_TOKEN_VALIDITY = Duration.hours(1);
export const ACCESS_TOKEN_VALIDITY = Duration.hours(1);
/** The longest a sign-in lasts without going through Google again. */
export const REFRESH_TOKEN_VALIDITY = Duration.days(1);

export interface AuthStackProps extends StackProps {
  collegeDomain: string;
  /** Founders (lower case) who may sign in as super admins from a non-college address. */
  superAdminEmails: string[];
  webOrigins: string[];
  usersTable: Table;
}

export class AuthStack extends Stack {
  readonly userPool: UserPool;
  readonly userPoolClient: UserPoolClient;
  readonly userPoolDomain: UserPoolDomain;
  readonly preSignUpFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    this.preSignUpFunction = createNodeFunction(this, 'PreSignUpFunction', {
      entry: serviceEntry('api/src/handlers/pre-sign-up.ts'),
      description:
        'Rejects sign-ups outside the college domain and founder list, or not listed in Users',
      environment: {
        COLLEGE_DOMAIN: props.collegeDomain,
        SUPER_ADMIN_EMAILS: props.superAdminEmails.join(','),
        USERS_TABLE: props.usersTable.tableName,
      },
    });
    props.usersTable.grantReadData(this.preSignUpFunction);

    this.userPool = new UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      removalPolicy: RemovalPolicy.RETAIN,
      lambdaTriggers: { preSignUp: this.preSignUpFunction },
    });

    const google = new UserPoolIdentityProviderGoogle(this, 'Google', {
      userPool: this.userPool,
      clientId: SecretValue.secretsManager(GOOGLE_OAUTH_SECRET_NAME, {
        jsonField: 'clientId',
      }).unsafeUnwrap(),
      clientSecretValue: SecretValue.secretsManager(GOOGLE_OAUTH_SECRET_NAME, {
        jsonField: 'clientSecret',
      }),
      scopes: ['openid', 'email', 'profile'],
      attributeMapping: {
        email: ProviderAttribute.GOOGLE_EMAIL,
        fullname: ProviderAttribute.GOOGLE_NAME,
      },
    });

    this.userPoolDomain = this.userPool.addDomain('HostedUiDomain', {
      cognitoDomain: { domainPrefix: `dsa-judge-${this.account}` },
    });

    // Public SPA client: no secret, authorization code grant (PKCE is required for public clients).
    this.userPoolClient = this.userPool.addClient('SpaClient', {
      generateSecret: false,
      // The web app keeps people signed in across reloads by renewing its tokens with the refresh
      // token (a refresh_token grant at the token endpoint). Refresh tokens are not rotated, so
      // their validity is also the longest a session can last: one day. No password sign-in is
      // used, so ALLOW_REFRESH_TOKEN_AUTH is the only auth flow enabled.
      // (CDK ignores an empty object, so one flag is spelled out to get the explicit list.)
      authFlows: { userSrp: false },
      idTokenValidity: ID_TOKEN_VALIDITY,
      accessTokenValidity: ACCESS_TOKEN_VALIDITY,
      refreshTokenValidity: REFRESH_TOKEN_VALIDITY,
      enableTokenRevocation: true,
      supportedIdentityProviders: [UserPoolClientIdentityProvider.GOOGLE],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
        callbackUrls: props.webOrigins.map((origin) => `${origin}/auth/callback`),
        logoutUrls: props.webOrigins.map((origin) => `${origin}/`),
      },
    });
    this.userPoolClient.node.addDependency(google);

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
    new CfnOutput(this, 'HostedUiBaseUrl', { value: this.userPoolDomain.baseUrl() });
  }
}
