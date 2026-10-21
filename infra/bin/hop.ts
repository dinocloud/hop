#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { CiStack } from '../lib/ci-stack.js';
import { HopStack } from '../lib/hop-stack.js';

const app = new cdk.App();

// La cuenta y la región se fijan por contexto (cdk.json) para que `cdk synth`
// sea determinístico y no dependa de credenciales ni de CDK_DEFAULT_*.
const account = requireContext('hop:account');
const region = requireContext('hop:region');
const stage = requireContext('hop:stage');
const githubRepo = requireContext('hop:githubRepo');
const githubSubjectPrefix = requireContext('hop:githubSubjectPrefix');
const templateName = requireContext('hop:templateName');
const templateLanguage = requireContext('hop:templateLanguage');
const metaApiVersion = requireContext('hop:metaApiVersion');
const agentModelId = requireContext('hop:agentModelId');

const env: cdk.Environment = { account, region };

// Rol OIDC para GitHub Actions. Se despliega UNA vez a mano (ver README).
// El id del construct (`HopHackathonCi`) es el que se usa en `cdk deploy`; el nombre físico
// del stack en CloudFormation lleva el prefijo del proyecto, como todos los recursos.
new CiStack(app, 'HopHackathonCi', {
  env,
  stackName: 'hop-hackathon-ci',
  description: 'HOP hackathon - rol OIDC para que GitHub Actions despliegue con CDK',
  githubRepo,
  githubSubjectPrefix,
  deployBranches: ['main'],
});

// Stack de la aplicación. Lo despliega el pipeline al mergear a main.
new HopStack(app, 'HopHackathonDev', {
  env,
  stackName: `hop-hackathon-${stage}`,
  description: 'HOP hackathon - WhatsApp (End User Messaging Social) + AgentCore',
  stage,
  templateName,
  templateLanguage,
  metaApiVersion,
  agentModelId,
});

// Tags para identificar todo lo del proyecto en una cuenta compartida.
cdk.Tags.of(app).add('Project', 'hop-hackathon');
cdk.Tags.of(app).add('Environment', stage);
cdk.Tags.of(app).add('ManagedBy', 'cdk');
cdk.Tags.of(app).add('Repository', `github.com/${githubRepo}`);

// Chequeos de buenas prácticas AWS. Las supresiones viven junto al recurso con su justificación.
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

function requireContext(key: string): string {
  const value = app.node.tryGetContext(key);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Falta el contexto "${key}" en cdk.json`);
  }
  return value;
}
