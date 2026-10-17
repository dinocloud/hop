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
    deployEnvironments: ['dev'],
  });
  const template = Template.fromStack(stack);

  it('no crea un proveedor OIDC: reutiliza el de la cuenta', () => {
    template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
    template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
  });

  it('acota el trust al repo, la rama main y el environment dev', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'hop-hackathon-github-deploy',
      MaxSessionDuration: 3600,
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
              StringLike: {
                'token.actions.githubusercontent.com:sub': [
                  'repo:dinocloud/hop:ref:refs/heads/main',
                  'repo:dinocloud/hop:environment:dev',
                ],
              },
            },
          }),
        ],
      },
    });
  });

  it('solo puede asumir los roles de bootstrap de CDK de la región', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Sid: 'AssumeCdkBootstrapRoles',
            Effect: 'Allow',
            Action: 'sts:AssumeRole',
            Resource: Match.arrayWith([
              'arn:aws:iam::123456789012:role/cdk-hnb659fds-deploy-role-123456789012-us-east-1',
              'arn:aws:iam::123456789012:role/cdk-hnb659fds-file-publishing-role-123456789012-us-east-1',
            ]),
          },
        ],
      },
    });
    const policies = template.findResources('AWS::IAM::Policy');
    expect(Object.keys(policies)).toHaveLength(1);
  });
});
