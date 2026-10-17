import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import {
  Distribution,
  HttpVersion,
  ResponseHeadersPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/**
 * Where the React app is served from: a private S3 bucket behind CloudFront. It depends on no other
 * stack, so Auth, API and Data can take its URL (for Cognito callbacks and CORS) while WebDeploy,
 * which needs values from Auth and API, puts the files in the bucket afterwards.
 */
export class WebHostingStack extends Stack {
  readonly bucket: Bucket;
  readonly distribution: Distribution;
  /** https://<id>.cloudfront.net, with no trailing slash. A deploy-time value. */
  readonly siteUrl: string;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.bucket = new Bucket(this, 'SiteBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.distribution = new Distribution(this, 'Distribution', {
      comment: 'Paper DSA Exam Judge web app',
      defaultRootObject: 'index.html',
      httpVersion: HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        // Origin access control: only this distribution may read the bucket.
        origin: S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      // Single-page app: a path that is not a file (/teacher, /auth/callback) gets index.html and
      // the router takes over. A private bucket answers a missing key with 403, not 404.
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
        ttl: Duration.seconds(0),
      })),
    });

    this.siteUrl = `https://${this.distribution.distributionDomainName}`;

    new CfnOutput(this, 'SiteUrl', { value: this.siteUrl });
  }
}
