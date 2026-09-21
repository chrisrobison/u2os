# 0002 — Models are replaceable infrastructure

## Status

Accepted

## Context

Model vendors, capabilities, costs, privacy characteristics, and local runtimes change. Binding the product or its safety rules to one prompt/API would make owner data and core behavior dependent on that vendor.

## Decision

Models sit behind provider interfaces and role-based routing. U2OS supports deterministic mocks, local or hosted OpenAI-compatible endpoints, Anthropic, and separate embedding providers. Providers receive bounded structured context and return strictly validated plans. Models never receive direct tool handles and never become the source of identity, policy, or classification authority.

## Consequences

- The offline deterministic model remains a truthful test/demo fixture rather than pretending to be general intelligence.
- Owners can replace planning and embedding providers without replacing the agent, tools, memory, or policy engine.
- Provider-specific credentials and failure behavior stay behind adapters.
- Every provider output needs local schema validation and conservative failure handling.
- Capability differences may require explicit role configuration and bounded fallback behavior.

See [models](../models.md) and [architecture](../architecture.md).
