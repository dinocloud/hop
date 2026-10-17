import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface CiStackProps extends cdk.StackProps {
  /** `owner/repo` en GitHub. */
  readonly githubRepo: string;
  /** Ramas que pueden desplegar (push). */
  readonly deployBranches: string[];
  /** GitHub Environments que pueden desplegar. */
  readonly deployEnvironments: string[];
}

/**
 * Rol que asume GitHub Actions por OIDC para correr `cdk deploy`.
 *
 * Reglas:
 * - Reutiliza el proveedor OIDC de GitHub que ya existe en la cuenta. No lo crea ni lo modifica.
 * - El trust queda acotado al repo, a las ramas y a los environments indicados.
 * - El rol solo puede asumir los roles de bootstrap de CDK de esta región. No tiene
 *   permisos propios sobre servicios: CloudFormation ejecuta con `cfn-exec-role`.
 */
export class CiStack extends cdk.Stack {
  readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: CiStackProps) {
    super(scope, id, props);

    const providerArn = `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`;
    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GithubOidcProvider', providerArn);

    const subjects = [
      ...props.deployBranches.map((branch) => `repo:${props.githubRepo}:ref:refs/heads/${branch}`),
      ...props.deployEnvironments.map((environment) => `repo:${props.githubRepo}:environment:${environment}`),
    ];

    this.deployRole = new iam.Role(this, 'DeployRole', {
      roleName: 'hop-hackathon-github-deploy',
      description: `Deploy de HopHackathonDev desde GitHub Actions (${props.githubRepo})`,
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: { 'token.actions.githubusercontent.com:sub': subjects },
      }),
      maxSessionDuration: cdk.Duration.hours(1),
    });

    // Mínimo privilegio para CDK: solo los roles de bootstrap de esta cuenta/región.
    // El qualifier `hnb659fds` es el default del bootstrap moderno de CDK.
    const bootstrapRoles = ['deploy', 'file-publishing', 'image-publishing', 'lookup'].map(
      (name) => `arn:aws:iam::${this.account}:role/cdk-hnb659fds-${name}-role-${this.account}-${this.region}`,
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        effect: iam.Effect.ALLOW,
        actions: ['sts:AssumeRole'],
        resources: bootstrapRoles,
      }),
    );

    new cdk.CfnOutput(this, 'DeployRoleArn', {
      value: this.deployRole.roleArn,
      description: 'Cargar como variable AWS_DEPLOY_ROLE_ARN en GitHub (Settings > Secrets and variables > Actions > Variables)',
    });
  }
}
