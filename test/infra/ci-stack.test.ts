import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { CiStack } from '../../infra/lib/ci-stack.js';

describe('CiStack', () => {
  const app = new cdk.App();
  const stack = new CiStack(app, 'HopHackathonCi', {
    env: { account: '123456789012', region: 'us-east-1' },
    githubRepo: 'dinocloud/hop',
    deployBranches: ['main'],
  });
  const template = Template.fromStack(stack);

  it('no crea un proveedor OIDC: reutiliza el de la cuenta', () => {
    template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
    template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
  });

  it('acepta solo tokens de push a main del repo (StringEquals, sin environments ni PRs)', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'hop-hackathon-github-deploy',
      MaxSessionDuration: 3600,
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub': ['repo:dinocloud/hop:ref:refs/heads/main'],
              },
            },
          }),
        ],
      },
    });
    const role = Object.values(template.findResources('AWS::IAM::Role'))[0] as { Properties: { AssumeRolePolicyDocument: unknown } };
    const trust = JSON.stringify(role.Properties.AssumeRolePolicyDocument);
    expect(trust).not.toContain('environment:');
    expect(trust).not.toContain('pull_request');
    expect(trust).not.toContain('StringLike');
  });

  it('solo puede asumir los roles de bootstrap de CDK que usa el deploy (sin image-publishing)', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Sid: 'AssumeCdkBootstrapRoles',
            Effect: 'Allow',
            Action: 'sts:AssumeRole',
            Resource: [
              'arn:aws:iam::123456789012:role/cdk-hnb659fds-deploy-role-123456789012-us-east-1',
              'arn:aws:iam::123456789012:role/cdk-hnb659fds-file-publishing-role-123456789012-us-east-1',
              'arn:aws:iam::123456789012:role/cdk-hnb659fds-lookup-role-123456789012-us-east-1',
            ],
          },
        ],
      },
    });
    expect(Object.keys(template.findResources('AWS::IAM::Policy'))).toHaveLength(1);
    expect(Object.keys(template.findResources('AWS::IAM::Role'))).toHaveLength(1);
  });
});
