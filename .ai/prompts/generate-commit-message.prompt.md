---
description: "Generate a Conventional Commit message for the staged changes in this repository."
argument-hint: "Optional: extra context for the staged change set"
agent: commit-message
---

# Generate Commit Message

Generate a Conventional Commit message describing the staged changes.

> **See:** [commit-message](/.ai/agents/commit-message.agent.md) for scope resolution,
> message rules, and output format.

## Usage

`/generate-commit-message ${input:context}` — context is optional extra detail about the change set.

## Process

1. Apply the referenced agent's staged-diff scope, constraints, and message rules.
2. Use any supplied context to clarify intent without inventing changes.
3. Return the agent's prescribed output, including its empty-staging response when applicable.

## Related

- [commit-message](/.ai/agents/commit-message.agent.md) - Commit message agent
