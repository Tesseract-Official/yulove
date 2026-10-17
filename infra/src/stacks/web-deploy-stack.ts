import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import type { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import type { UserPoolClient, UserPoolDomain } from 'aws-cdk-lib/aws-cognito';
import { BucketDeployment, CacheControl, Source } from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';
import { WEB_DIST_DIR } from '../lib/handler-paths.js';
import type { WebHostingStack } from './web-hosting-stack.js';

export interface WebDeployStackProps extends StackProps {
  hosting: WebHostingStack;
  userPoolClient: UserPoolClient;
  userPoolDomain: UserPoolDomain;
  httpApi: HttpApi;
  /** The built web app (`pnpm --filter @yulove/web build`). */
  webDistPath?: string;
}

/**
 * Uploads the built web app, plus a config.json made from the Auth and API stacks' values, to the
 * hosting bucket and clears CloudFront's cache. It is the only stack that depends on all of them.
 */
export class WebDeployStack extends Stack {
  constructor(scope: Construct, id: string, props: WebDeployStackProps) {
    super(scope, id, props);
    const { hosting } = props;

    new BucketDeployment(this, 'Deployment', {
      destinationBucket: hosting.bucket,
      distribution: hosting.distribution,
      distributionPaths: ['/*'],
      sources: [
        Source.asset(props.webDistPath ?? WEB_DIST_DIR),
        // The values are only known at deploy time, so the file is filled in then. This is what
        // the app reads at startup (web/src/config/config.ts).
        Source.jsonData('config.json', {
          apiUrl: props.httpApi.apiEndpoint,
          cognitoDomain: props.userPoolDomain.baseUrl(),
          clientId: props.userPoolClient.userPoolClientId,
          redirectUri: `${hosting.siteUrl}/auth/callback`,
          logoutUri: `${hosting.siteUrl}/`,
        }),
      ],
      // Always revalidate: index.html and config.json must never be stale, and the app is small.
      cacheControl: [CacheControl.noCache()],
      prune: true,
    });

    new CfnOutput(this, 'SiteUrl', { value: hosting.siteUrl });
  }
}
