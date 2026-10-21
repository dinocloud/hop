import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface CiStackProps extends cdk.StackProps {
  /** `owner/repo` en GitHub. */
  readonly githubRepo: string;
  /**
   * Prefijo del claim `sub` de los tokens OIDC del repo (`sub_claim_prefix` de
   * `GET /repos/{owner}/{repo}/actions/oidc/customization/sub`). Los repos nuevos usan
   * subjects inmutables: `repo:<owner>@<ownerId>/<repo>@<repoId>`, no `repo:<owner>/<repo>`.
   */
  readonly githubSubjectPrefix: string;
  /** Ramas que pueden desplegar (push). Solo `main` en este proyecto. */
  readonly deployBranches: string[];
}

/**
 * Rol que asume GitHub Actions por OIDC para correr `cdk deploy`.
 *
 * Importante: el rol de ejecución de CloudFormation del bootstrap de CDK (`cfn-exec-role`)
 * tiene AdministratorAccess en esta cuenta, como en cualquier bootstrap por defecto. Por eso
 * quien pueda asumir este rol puede, en la práctica, tocar toda la cuenta compartida. Los
 * controles son:
 * - El trust acepta ÚNICAMENTE tokens emitidos para un push a las ramas de `deployBranches`
 *   del repo. No se aceptan subjects de environments, PRs ni otras ramas.
 * - En GitHub, `main` tiene que estar protegida (PR con revisión obligatoria): es la puerta
 *   real de entrada al deploy.
 * - El rol solo puede asumir los roles de bootstrap de CDK de esta región; no tiene permisos
 *   propios sobre servicios.
 * - Reutiliza el proveedor OIDC de GitHub que ya existe en la cuenta. No lo crea ni lo modifica.
 */
export class CiStack extends cdk.Stack {
  readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: CiStackProps) {
    super(scope, id, props);

    const providerArn = `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`;
    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GithubOidcProvider', providerArn);

    if (!props.githubSubjectPrefix.startsWith('repo:')) {
      throw new Error(`githubSubjectPrefix tiene que empezar con "repo:" (recibido: "${props.githubSubjectPrefix}")`);
    }
    const subjects = props.deployBranches.map((branch) => `${props.githubSubjectPrefix}:ref:refs/heads/${branch}`);

    this.deployRole = new iam.Role(this, 'DeployRole', {
      roleName: 'hop-hackathon-github-deploy',
      description: `Deploy de hop-hackathon-dev desde GitHub Actions (${props.githubRepo}, ramas: ${props.deployBranches.join(', ')})`,
      assumedBy: new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': subjects,
        },
      }),
      maxSessionDuration: cdk.Duration.hours(1),
    });

    // Mínimo privilegio para CDK: solo los roles de bootstrap de esta cuenta/región que usa
    // `cdk deploy` sin imágenes Docker (deploy, publicación de assets a S3 y lookups).
    // El qualifier `hnb659fds` es el default del bootstrap moderno de CDK.
    const bootstrapRoles = ['deploy', 'file-publishing', 'lookup'].map(
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
