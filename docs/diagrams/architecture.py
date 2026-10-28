"""
WhatsApp package-tracking agent: what talks to what.

Needs the aws-diagram skill from the DinoCloud toolkit: its setup.sh creates a venv with
`diagrams` and copies the `aws_diagram_theme` module into it. Then, from the repo root:
    ~/.dino/aws-diagram/.venv/bin/python docs/diagrams/architecture.py

Writes docs/diagrams/architecture.png. No SVG on purpose: graphviz links each icon by its absolute
path on the machine that rendered it, so the SVG shows no icons anywhere else. The source of truth
is infra/lib/hop-stack.ts: update this file when the stack changes.
"""

import os

from diagrams.aws.compute import Lambda
from diagrams.aws.database import Dynamodb
from diagrams.aws.engagement import Pinpoint
from diagrams.aws.integration import SNS, SQS
from diagrams.aws.management import Cloudwatch
from diagrams.aws.ml import Bedrock
from diagrams.aws.network import APIGateway
from diagrams.generic.device import Mobile
from diagrams.onprem.client import Client

from aws_diagram_theme import cluster, diagram, edge

OUTDIR = os.environ.get("OUTDIR", "docs/diagrams")

with diagram(
    "WhatsApp package-tracking agent",
    outdir=OUTDIR,
    filename="architecture",
    formats=("png",),
    direction="LR",
    caption="Hackathon PoC · synthetic data",
    confidential=True,
    # White background: GitHub's dark mode and dark slides make the default transparent one unreadable.
    graph_attr={"bgcolor": "white"},
):
    customer = Mobile("Customer\n(WhatsApp)")
    shipping = Client("Shipping system\n(simulated)")

    with cluster("AWS account · us-east-1"):
        # `diagrams` has no End User Messaging icon; Pinpoint is the service it grew out of.
        messaging = Pinpoint("End User Messaging\nSocial")

        api = APIGateway("REST API\n(API key)")
        hook = Lambda("package-status-hook")

        topic = SNS("Inbound topic")
        router = Lambda("inbound-router")
        dlq = SQS("Dead-letter queue")

        # `diagrams` has no AgentCore icon; AgentCore is part of Amazon Bedrock.
        agent = Bedrock("AgentCore Runtime\nStrands agent")
        model = Bedrock("Claude Sonnet 5.5\n(Amazon Bedrock)")

        conversations = Dynamodb("Conversations\n+ message dedupe")
        packages = Dynamodb("Packages\n+ pickup points")

        # No edges on purpose: everything logs here, and drawing every arrow buries the two flows.
        Cloudwatch("CloudWatch\nlogs · metrics · alarms\n(every component)")

    # Proactive notice: the shipping system reports that a package reached its pickup point.
    shipping >> edge("POST /packages/{id}/status") >> api >> edge("proxy") >> hook
    hook >> edge("status + deadline") >> packages
    hook >> edge("paquete_listo template") >> messaging

    # Conversation: the customer writes and the agent answers.
    customer - edge("WhatsApp\n(Meta Cloud API)", forward=True, reverse=True) - messaging
    messaging >> edge("inbound event") >> topic >> edge("subscription") >> router
    router >> edge("failed events", style="dashed") >> dlq
    router >> edge("24 h window · session") >> conversations
    router >> edge("InvokeAgentRuntime") >> agent
    agent >> edge("Converse") >> model
    agent >> edge("tools: read · confirmed writes") >> packages
    router >> edge("text + location") >> messaging
