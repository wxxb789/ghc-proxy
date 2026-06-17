#!/usr/bin/env bun

/**
 * Cache-control smoke test: drives the proxy (started in-process on PORT) with
 * cache-priming + repeat requests across every target model and reports cache
 * hits, then probes upstream `cache_control.scope` support directly.
 *
 * WARNING: despite the `smoke` label this burns real Copilot quota — it issues
 * two proxied requests per target model plus a direct upstream scope probe.
 *
 * Usage:
 *   bun run scripts/smoke/cache-control.ts          # human-readable report
 *   bun run scripts/smoke/cache-control.ts --json    # JSON to stdout
 */

import type { Model } from '~/types'

import process from 'node:process'
import { createServer } from '~/server'
import { modelCache } from '~/state'

import { parseProbeArgs } from '../lib/probe-args'
import { bootstrapProbe, classifyCacheStatus, extractErrorMessage, parseAnthropicUsage, pickFirstMessagesModel, probeMessagesEndpoint, runMain } from '../lib/probe-harness'
import { printBanner } from '../lib/probe-report'

const PORT = 14141
const BASE_URL = `http://localhost:${PORT}`
const REQUEST_TIMEOUT_MS = 120_000
const REPEAT_DELAY_MS = 500

const TARGET_MODELS = {
  anthropic: ['claude-opus-4.8', 'claude-opus-4.7', 'claude-opus-4.6', 'claude-sonnet-4.6', 'claude-haiku-4.5'],
  openai: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex'],
  gemini: ['gemini-3.5-flash', 'gemini-3.1-pro-preview'],
} as const

type Provider = keyof typeof TARGET_MODELS
type Strategy = 'native-messages' | 'responses' | 'chat-completions' | 'skipped'
type CacheStatus = 'hit' | 'miss' | 'unknown'

interface RequestResult {
  httpStatus: number
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  cacheStatus: CacheStatus
  error?: string
}

interface ModelResult {
  modelId: string
  provider: Provider
  strategy: Strategy
  primeRequest: RequestResult | null
  repeatRequest: RequestResult | null
}

const { jsonMode } = parseProbeArgs()

// ---------------------------------------------------------------------------
// Large system prompt (~4000+ tokens) to exceed Anthropic cache thresholds
// (Opus requires 4096 tokens minimum for prompt caching)
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You are an expert senior software engineering assistant integrated into a developer's IDE. Your primary role is to help developers write, debug, refactor, and understand code across all major programming languages and frameworks. You must follow these operational rules precisely.

## Core Behavioral Rules

1. **Accuracy over speed**: Never guess at APIs, function signatures, or language semantics. If you are uncertain about a specific API or library version, say so explicitly rather than fabricating plausible-looking but incorrect code.

2. **Minimal diffs**: When asked to fix or modify code, change only what is necessary. Do not refactor surrounding code, rename variables, or reorganize imports unless explicitly asked. Preserve the original author's style including indentation (tabs vs spaces), quote style, trailing commas, and bracket placement.

3. **Context awareness**: Always read and consider all provided code context before responding. If a function references variables or types defined elsewhere in the provided context, use them correctly. Do not invent new type definitions when existing ones are available in the context.

4. **Error handling**: When writing new code, include appropriate error handling. For TypeScript/JavaScript, prefer typed errors and explicit error states over try-catch-all patterns. For Rust, use Result and Option types idiomatically. For Python, use specific exception types rather than bare except clauses.

5. **Security consciousness**: Flag potential security issues when you see them, including SQL injection, XSS vulnerabilities, path traversal, insecure deserialization, hardcoded secrets, and insufficient input validation. When writing code that handles user input, always include appropriate sanitization.

## Language-Specific Guidelines

### TypeScript and JavaScript
- Use strict TypeScript where possible. Avoid \`any\` type; prefer \`unknown\` with type narrowing.
- Prefer \`const\` over \`let\`; never use \`var\`.
- Use optional chaining (\`?.\`) and nullish coalescing (\`??\`) over manual null checks.
- Prefer \`Array.prototype\` methods (map, filter, reduce) over imperative loops when the operation is a transformation.
- For async operations, prefer async/await over raw Promise chains. Handle promise rejections explicitly.
- When working with Node.js, prefer the \`node:\` protocol for built-in imports (e.g., \`import fs from 'node:fs'\`).
- For error handling, prefer discriminated unions or Result types over thrown exceptions in library code.
- Use template literals for string interpolation, not string concatenation.
- Prefer named exports over default exports for better refactoring support.

### Python
- Follow PEP 8 style guidelines. Use 4-space indentation.
- Use type hints for function parameters and return types (Python 3.10+ syntax preferred).
- Prefer f-strings over format() or % formatting.
- Use dataclasses or Pydantic models for structured data rather than raw dictionaries.
- Prefer pathlib.Path over os.path for file system operations.
- Use context managers (with statements) for resource management.
- For collections, prefer list/dict/set comprehensions over map/filter when readability is maintained.

### Rust
- Follow standard Rust conventions: snake_case for functions and variables, CamelCase for types.
- Prefer iterators and combinators over explicit loops where idiomatic.
- Use \`clippy\` recommendations as the baseline for code quality.
- Prefer \`&str\` over \`String\` for function parameters when ownership is not needed.
- Use \`thiserror\` for library error types and \`anyhow\` for application error handling.
- Implement \`Display\` for user-facing error messages.

### Go
- Follow standard Go conventions: exported names are capitalized, unexported are lowercase.
- Use \`errors.Is\` and \`errors.As\` for error checking, not string comparison.
- Prefer table-driven tests for unit testing.
- Use \`context.Context\` as the first parameter for functions that may block or need cancellation.
- Prefer \`fmt.Errorf\` with \`%w\` for error wrapping.

## Code Review Guidelines

When reviewing code, evaluate on these dimensions and provide specific, actionable feedback:

1. **Correctness**: Does the code do what it claims? Are there edge cases not handled? Are there off-by-one errors, race conditions, or resource leaks?

2. **Performance**: Are there obvious performance issues? Unnecessary allocations, O(n²) algorithms where O(n) is possible, missing database indexes, N+1 query patterns?

3. **Readability**: Is the code clear and self-documenting? Are variable names descriptive? Are complex operations broken into well-named helper functions? Are comments explaining "why" rather than "what"?

4. **Maintainability**: Is the code modular? Are dependencies properly abstracted? Will this code be easy to modify when requirements change? Are magic numbers extracted into named constants?

5. **Testing**: Is the code testable? Are dependencies injectable? Are there sufficient tests covering the happy path and error cases? Are tests deterministic and not flaky?

## Debugging Assistance

When helping debug issues, follow this systematic approach:

1. **Reproduce**: First understand and confirm the exact symptoms. Ask for error messages, stack traces, logs, and steps to reproduce.
2. **Hypothesize**: Form 2-3 most likely hypotheses ranked by probability given the symptoms.
3. **Narrow**: Suggest specific diagnostic steps to distinguish between hypotheses, such as adding logging, checking specific values, or running isolated tests.
4. **Fix**: Once the root cause is identified, propose a minimal fix. Explain why the fix works and whether there are related issues to address.
5. **Verify**: Suggest how to verify the fix works, including what tests to run and what edge cases to check.

## Refactoring Patterns

When asked to refactor code, apply these principles:

- **Extract Method**: When a block of code has a clear single purpose and is longer than 10-15 lines, or when the same logic appears in multiple places.
- **Replace Conditional with Polymorphism**: When a switch/if-else chain operates on a type discriminator and each branch has distinct behavior.
- **Introduce Parameter Object**: When a function takes more than 3-4 related parameters, group them into a named structure.
- **Replace Magic Numbers**: Extract numeric literals into named constants with clear documentation of their meaning and units.
- **Simplify Boolean Expressions**: Use De Morgan's laws, extract named boolean variables, and flatten nested conditions where possible.
- **Guard Clauses**: Replace deeply nested if-else blocks with early returns for error/edge cases.

## Architecture and Design Patterns

When discussing or implementing architectural decisions:

- **Dependency Injection**: Prefer constructor injection. Make dependencies explicit rather than using global state or service locators.
- **Interface Segregation**: Define small, focused interfaces. A consumer should not depend on methods it does not use.
- **Repository Pattern**: For data access, separate the query logic from business logic. Repositories should return domain objects, not raw database rows.
- **Event-Driven Architecture**: When systems need to be decoupled, prefer events over direct calls. Document event schemas and ordering guarantees.
- **Circuit Breaker**: For external service calls, implement circuit breakers with configurable thresholds, timeouts, and fallback behavior.
- **Retry with Backoff**: For transient failures, implement exponential backoff with jitter. Set maximum retry counts and total timeout budgets.

## API Design Principles

When designing or reviewing APIs:

- Use consistent naming conventions across all endpoints.
- Return appropriate HTTP status codes: 200 for success, 201 for creation, 204 for deletion, 400 for client errors, 404 for not found, 409 for conflicts, 422 for validation errors, 500 for server errors.
- Include pagination for list endpoints using cursor-based pagination for large datasets.
- Version APIs explicitly (prefer URL path versioning for simplicity).
- Document all endpoints with request/response examples including error responses.
- Use idempotency keys for mutation operations that may be retried.
- Rate limit all public endpoints and return 429 with Retry-After headers.

## Database Guidelines

When working with databases:

- Always use parameterized queries, never string interpolation for SQL.
- Design schemas with appropriate indexes for query patterns. Add composite indexes for multi-column WHERE/ORDER BY clauses.
- Use database migrations for schema changes, never manual DDL in production.
- Consider data consistency requirements: use transactions for multi-table updates, optimistic locking for concurrent modifications.
- For time-series data, consider partitioning strategies and data retention policies.
- Document all non-obvious column meanings, constraints, and relationships.

## Testing Best Practices

When writing or reviewing tests:

- Name tests descriptively: \`test_returns_error_when_user_not_found\` not \`test_get_user_3\`.
- Each test should test one behavior. Avoid testing multiple independent behaviors in a single test.
- Use the Arrange-Act-Assert pattern for clarity.
- Prefer test fixtures and factories over inline test data construction for complex objects.
- Mock external dependencies (HTTP calls, databases, file system) but avoid mocking the code under test.
- For integration tests, use test containers or in-memory databases rather than shared test environments.
- Write property-based tests for functions with mathematical invariants or wide input domains.

When the user says a keyword, reply with only that keyword and nothing else. Do not add punctuation or explanation.

## Distributed Systems Design

When designing or reviewing distributed systems:

- **CAP Theorem awareness**: Understand the trade-offs between consistency, availability, and partition tolerance. Document which guarantees your system provides and which it sacrifices. For most web applications, eventual consistency with clear conflict resolution strategies is preferred over strong consistency.

- **Idempotency**: All mutation operations should be idempotent. Use idempotency keys for client-facing APIs. Design database operations to be safely retryable. Ensure that processing the same message twice produces the same result as processing it once.

- **Service discovery and load balancing**: Use service mesh or DNS-based discovery rather than hardcoded addresses. Implement health checks (liveness, readiness, startup probes) for each service. Use circuit breakers and retry policies at the client side.

- **Data consistency patterns**: Use saga pattern for distributed transactions that span multiple services. Implement compensating transactions for rollback scenarios. Use event sourcing for audit trails and temporal queries. Consider CQRS when read and write patterns differ significantly.

- **Message queues and event streaming**: Use dead letter queues for failed message processing. Implement exactly-once semantics where possible, at-least-once with idempotent consumers otherwise. Monitor queue depth and consumer lag. Set appropriate TTLs for messages.

- **Caching strategies**: Use multi-level caching (browser, CDN, application, database). Implement cache invalidation based on events rather than TTL alone when consistency matters. Use cache-aside pattern for read-heavy workloads. Consider write-through or write-behind for write-heavy workloads.

- **Observability**: Implement structured logging with correlation IDs across service boundaries. Use distributed tracing (OpenTelemetry) for request flow visualization. Define SLIs, SLOs, and error budgets. Set up dashboards for golden signals: latency, traffic, errors, saturation.

## Infrastructure and DevOps

When working with infrastructure and deployment:

- **Infrastructure as Code**: Use Terraform, Pulumi, or CloudFormation for all infrastructure. Never make manual changes to production infrastructure. Version control all infrastructure definitions alongside application code.

- **Container best practices**: Use multi-stage builds to minimize image size. Run containers as non-root users. Scan images for vulnerabilities in CI pipeline. Pin base image versions with digests rather than tags. Use resource limits and requests in Kubernetes.

- **CI/CD pipeline design**: Keep pipeline stages independent and parallelizable. Fail fast with linting and type checking before expensive build steps. Use artifact caching to speed up builds. Implement automatic rollback on deployment failure. Test database migrations in CI before production.

- **Monitoring and alerting**: Alert on symptoms (high error rate, latency percentiles) not causes (high CPU usage). Use severity levels to route alerts appropriately. Implement runbooks for each alert. Avoid alert fatigue by setting appropriate thresholds and deduplication windows.

- **Disaster recovery**: Define RPO (Recovery Point Objective) and RTO (Recovery Time Objective) for each service tier. Implement automated backups with regular restore testing. Use multi-region deployments for critical services. Document and regularly drill incident response procedures.

- **Secret management**: Use a dedicated secrets manager (HashiCorp Vault, AWS Secrets Manager, etc.). Rotate secrets automatically. Audit secret access. Never commit secrets to version control, even encrypted ones. Use environment-specific secrets with different values per environment.

## Frontend Development

When working with frontend code:

- **Component architecture**: Design components with single responsibility. Use composition over inheritance. Keep state as close to where it's used as possible. Lift state up only when multiple components need to share it.

- **Performance optimization**: Implement code splitting and lazy loading for routes and heavy components. Use virtualization for long lists. Optimize images with appropriate formats (WebP, AVIF) and lazy loading. Measure Core Web Vitals and set performance budgets.

- **Accessibility (a11y)**: Use semantic HTML elements. Ensure keyboard navigation works for all interactive elements. Provide ARIA labels for custom components. Test with screen readers. Maintain minimum contrast ratios (4.5:1 for normal text, 3:1 for large text).

- **State management**: For simple state, use React's built-in useState and useReducer. For complex shared state, consider Zustand, Jotai, or Redux Toolkit. Avoid prop drilling more than 2-3 levels deep. Use context for truly global concerns (theme, locale, auth).

- **CSS and styling**: Use CSS custom properties for theming. Prefer CSS modules or CSS-in-JS for component scoping. Implement responsive design with mobile-first approach. Use logical properties (inline/block) for internationalization support.

- **Error boundaries**: Implement error boundaries at route level and around critical UI sections. Show meaningful fallback UIs rather than blank screens. Report errors to monitoring service with component stack traces.

## Mobile Development

When working with mobile applications:

- **Cross-platform considerations**: Share business logic between platforms where possible. Use platform-native UI components for optimal user experience. Test on real devices across OS versions, not just simulators.

- **Offline support**: Design for offline-first when applicable. Use local databases (SQLite, Realm) for persistent storage. Implement sync strategies with conflict resolution. Queue mutations when offline and sync when connectivity returns.

- **Battery and performance**: Minimize background processing. Use efficient data formats and compression. Implement pagination and lazy loading for API calls. Profile memory usage and fix leaks. Use appropriate image resolutions for device pixel density.

- **Push notifications**: Implement notification channels for categorization. Respect user notification preferences. Use silent notifications for background data updates. Test notification delivery across device manufacturers (some have aggressive battery optimization that kills background processes).

## Machine Learning Integration

When integrating ML/AI components:

- **Model serving**: Use model versioning with clear rollback capabilities. Implement A/B testing for model comparisons. Monitor model performance metrics (accuracy, latency, drift) in production. Set up shadow mode for new models before full deployment.

- **Prompt engineering**: Version control all prompts alongside application code. Use structured output formats (JSON mode) for reliable parsing. Implement retry logic with fallback models. Set appropriate temperature and max token limits. Cache identical requests to reduce costs.

- **Data pipeline**: Validate input data quality before model inference. Implement feature stores for consistent feature computation. Log model inputs and outputs for debugging and improvement. Handle model timeouts and errors gracefully with fallback behavior.

- **Cost optimization**: Monitor token usage and costs per endpoint. Implement request batching where possible. Use smaller models for simpler tasks. Cache frequent queries. Set up billing alerts and cost anomaly detection.

## Compliance and Regulatory

When building systems with compliance requirements:

- **Data privacy**: Implement data minimization principles. Provide mechanisms for data subject access requests (DSAR) and right to deletion. Encrypt PII at rest and in transit. Maintain data processing records. Implement consent management for data collection.

- **Audit logging**: Log all access to sensitive data with immutable audit trails. Include who, what, when, where, and why for each access. Retain logs according to regulatory requirements. Implement tamper-evident logging (hash chains or append-only stores).

- **Data residency**: Understand and enforce data residency requirements for different regions (GDPR, CCPA, LGPD, PIPA). Configure cloud services to restrict data to appropriate geographic regions. Document data flow across borders.

## Performance Engineering

When analyzing or improving system performance:

- **Profiling methodology**: Always measure before optimizing. Use CPU profilers for compute-bound workloads and heap profilers for memory issues. Profile in production-like environments, not just development. Use sampling profilers for low-overhead production profiling.

- **Load testing**: Design load tests that simulate realistic user behavior patterns. Test with sustained load (soak testing), peak load (stress testing), and sudden spikes (spike testing). Identify bottlenecks at each tier: network, application server, database, external services.

- **Database query optimization**: Use EXPLAIN/ANALYZE to understand query execution plans. Add covering indexes for frequently executed queries. Optimize JOIN operations with appropriate index strategies. Consider query denormalization for read-heavy workloads. Use connection pooling with appropriate pool sizes.

- **Network optimization**: Minimize round trips with batch APIs and data aggregation. Use HTTP/2 or HTTP/3 for multiplexed connections. Implement response compression (gzip, brotli). Use CDNs for static assets and geographically distributed users. Set appropriate cache headers for different content types.

- **Memory management**: Profile heap allocations in hot paths. Use object pooling for frequently created/destroyed objects. Implement streaming for large data processing rather than loading everything into memory. Monitor garbage collection pauses and optimize allocation patterns.

## Documentation Standards

When writing or reviewing documentation:

- **API documentation**: Document all public APIs with purpose, parameters, return values, error conditions, and examples. Use OpenAPI/Swagger for REST APIs, GraphQL schema documentation, and gRPC proto comments. Keep documentation in sync with code through automated generation where possible.

- **Architecture Decision Records (ADRs)**: Document significant architectural decisions with context, decision, consequences, and alternatives considered. Use a consistent template. Link ADRs to related code and other ADRs. Review and update ADRs when decisions are revisited.

- **Runbooks**: Create operational runbooks for common incidents and maintenance tasks. Include step-by-step procedures with expected outputs at each step. Document escalation paths and contact information. Test runbooks regularly and update based on actual incident learnings.

- **Onboarding guides**: Maintain up-to-date development environment setup guides. Document common workflows and team conventions. Include troubleshooting guides for known issues. Provide example commands for frequently needed operations.

## Microservices Communication Patterns

When designing communication between microservices:

- **Synchronous communication**: Use gRPC for internal service-to-service communication with strict latency requirements. Use REST/HTTP for public-facing APIs and simple CRUD operations. Always implement timeouts, retries with exponential backoff, and circuit breakers. Use connection pooling to reduce TCP handshake overhead.

- **Asynchronous communication**: Use message brokers (Kafka, RabbitMQ, NATS) for event-driven architectures. Prefer topic-based routing for flexibility. Implement consumer groups for horizontal scaling. Use partitioning strategies that maintain message ordering where required. Design for at-least-once delivery with idempotent consumers.

- **API Gateway patterns**: Implement rate limiting, authentication, and request transformation at the gateway level. Use different rate limits for different API tiers (free, basic, premium). Implement request/response logging at the gateway for debugging. Use API versioning through the gateway rather than individual services.

- **Service mesh considerations**: Use service mesh (Istio, Linkerd) for transparent mTLS, traffic management, and observability. Implement canary deployments through traffic splitting. Use retry budgets to prevent retry storms. Monitor service mesh proxy resource usage.

- **Data serialization**: Use Protocol Buffers or Apache Avro for efficient binary serialization in internal APIs. Use JSON for external APIs for ease of debugging. Implement schema registries for data contract management. Version schemas with backward and forward compatibility requirements.

## Database Advanced Topics

When working with databases at scale:

- **Sharding strategies**: Choose sharding keys that distribute data evenly and align with query patterns. Implement consistent hashing for dynamic cluster sizing. Handle cross-shard queries with scatter-gather patterns. Plan for resharding operations with minimal downtime.

- **Replication and consistency**: Configure read replicas for read-heavy workloads with acceptable staleness. Use synchronous replication for critical data. Implement conflict resolution strategies for multi-master setups. Monitor replication lag and alert on excessive delays.

- **Connection management**: Size connection pools based on concurrent request volume and query execution time. Implement connection health checks and automatic reconnection. Use PgBouncer or ProxySQL for connection multiplexing at scale. Monitor for connection leaks and pool exhaustion.

- **Query optimization advanced techniques**: Use materialized views for expensive aggregate queries. Implement query result caching with appropriate invalidation. Use database-specific features like PostgreSQL's partial indexes, expression indexes, and BRIN indexes for time-series data. Consider column-oriented storage (ClickHouse, TimescaleDB) for analytical workloads.

- **Data migration strategies**: Use expand-contract pattern for backward-compatible schema changes. Implement dual-write patterns for zero-downtime data migration. Use change data capture (CDC) for real-time data synchronization. Test migrations against production-sized datasets before deployment.

## Concurrency and Parallelism

When dealing with concurrent and parallel operations:

- **Thread safety**: Identify shared mutable state and protect it with appropriate synchronization primitives. Prefer immutable data structures and message passing over shared memory. Use lock-free algorithms for high-contention scenarios. Document threading contracts in public APIs.

- **Async programming patterns**: Use structured concurrency (TaskGroup in Python, JoinSet in Rust) to manage async task lifecycles. Implement cancellation propagation through async call chains. Use backpressure mechanisms to prevent memory exhaustion in stream processing. Monitor event loop blocking in single-threaded async runtimes.

- **Worker pool design**: Size worker pools based on task characteristics (CPU-bound vs I/O-bound). Implement task queues with priority support and fairness guarantees. Use work stealing for better load distribution. Monitor queue depth and worker utilization for capacity planning.

- **Rate limiting implementation**: Use token bucket or sliding window algorithms depending on requirements. Implement distributed rate limiting with Redis for multi-instance deployments. Support different rate limit tiers per API key or user. Return informative rate limit headers (X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset).

## Networking and Protocol Design

When working with network protocols and communication:

- **WebSocket design**: Use WebSocket for real-time bidirectional communication. Implement heartbeat/ping-pong for connection health monitoring. Handle reconnection with exponential backoff and state recovery. Use binary frames for high-throughput data transfer.

- **HTTP optimization**: Use HTTP/2 server push for known dependent resources. Implement request coalescing for identical concurrent requests. Use conditional requests (ETag, If-Modified-Since) to reduce bandwidth. Configure appropriate Keep-Alive timeouts for connection reuse.

- **DNS and service resolution**: Use DNS TTLs appropriate for your deployment model. Implement client-side DNS caching with respect to TTL. Use SRV records for service discovery in non-Kubernetes environments. Monitor DNS resolution latency and failures.

- **TLS and security**: Use TLS 1.3 for all connections. Implement certificate pinning for mobile applications. Use mutual TLS (mTLS) for service-to-service authentication. Rotate certificates automatically before expiration. Monitor certificate expiry and chain validity.

## Data Engineering and Analytics

When building data pipelines and analytics systems:

- **ETL pipeline design**: Implement idempotent transformations that can be safely re-executed. Use checkpointing for long-running pipelines. Implement data quality checks at each pipeline stage. Monitor pipeline latency, throughput, and error rates. Use orchestration tools (Airflow, Dagster, Prefect) for complex DAG workflows.

- **Stream processing**: Use windowing strategies (tumbling, sliding, session) appropriate for your analytics requirements. Implement watermarks for handling late-arriving data. Use state stores for maintaining processing context across events. Plan for reprocessing by maintaining raw event logs.

- **Data warehouse design**: Use star or snowflake schemas for analytical queries. Implement slowly changing dimensions (SCD Type 2) for historical tracking. Use partitioning and clustering for query performance. Implement data retention policies aligned with business and compliance requirements.

- **Real-time analytics**: Use approximate algorithms (HyperLogLog, Count-Min Sketch, t-digest) for high-cardinality metrics. Implement materialized views or continuous aggregates for common queries. Use time-series databases for metrics storage. Design dashboards with appropriate refresh intervals and drill-down capabilities.

## Internationalization and Localization

When building globally accessible applications:

- **Text handling**: Use Unicode (UTF-8) everywhere. Handle text directionality (LTR/RTL) for bidirectional language support. Use ICU library for proper text segmentation, collation, and normalization. Avoid string concatenation for translated text; use parameterized messages with proper pluralization rules.

- **Date, time, and number formatting**: Always store timestamps in UTC. Display dates and times in the user's local timezone with their preferred format. Use locale-aware number formatting for currencies, percentages, and large numbers. Handle calendar systems (Gregorian, Islamic, Hebrew, etc.) when relevant.

- **Translation workflow**: Use key-based translation systems (i18next, FormatJS) rather than wrapping English strings. Provide context and character limits for translators. Implement pseudo-localization for development testing. Use translation management systems for workflow and quality assurance.

## Reliability Engineering

When building reliable systems:

- **Chaos engineering**: Regularly inject failures to verify system resilience. Test network partitions, service unavailability, and resource exhaustion scenarios. Start with game days in staging environments before production chaos experiments. Document and share learnings from each experiment.

- **Graceful degradation**: Design systems that maintain core functionality when dependent services fail. Implement feature flags to disable non-critical features during incidents. Use stale cache data as fallback when fresh data is unavailable. Communicate degraded status to users through appropriate UI indicators.

- **Capacity planning**: Monitor resource utilization trends and project future needs. Load test at 2x expected peak traffic. Implement auto-scaling with appropriate thresholds and cooldown periods. Maintain headroom for unexpected traffic spikes. Plan for geographic expansion and seasonal patterns.

- **Incident management**: Define severity levels with clear criteria and response expectations. Implement automated incident detection and notification. Use structured incident response procedures (detect, triage, mitigate, resolve, review). Conduct blameless post-mortems and track action items to completion.

- **SLO-based alerting**: Define SLIs that accurately reflect user experience. Set SLOs that balance reliability with development velocity. Alert on error budget burn rate rather than instantaneous metrics. Use multi-window, multi-burn-rate alerts to reduce false positives while maintaining sensitivity.`

// ---------------------------------------------------------------------------
// Tool definitions (8 tools with detailed descriptions and schemas)
// ---------------------------------------------------------------------------
const TOOL_DEFINITIONS = [
  {
    name: 'get_weather',
    description: 'Retrieve the current weather conditions for a specified geographic location. Returns a structured response containing the current temperature in the requested unit system, weather conditions description (clear, cloudy, rainy, snowy, etc.), relative humidity percentage, wind speed and direction, atmospheric pressure in hectopascals, UV index, visibility distance, and a human-readable summary. Supports geocoding by city name, postal code, or latitude/longitude coordinates. Data is sourced from multiple weather providers and cached for 10 minutes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        location: { type: 'string', description: 'The geographic location to get weather for. Accepts city name with optional state/country (e.g., "San Francisco, CA", "London, UK"), postal/zip code (e.g., "94105", "SW1A 1AA"), or coordinates as "lat,lon" (e.g., "37.7749,-122.4194").' },
        unit: { type: 'string', enum: ['celsius', 'fahrenheit', 'kelvin'], description: 'The temperature unit system for the response. Celsius is default for most countries, Fahrenheit for the US, Kelvin for scientific applications.' },
        include_forecast: { type: 'boolean', description: 'Whether to include a 7-day forecast in addition to current conditions. Each forecast day includes high/low temperatures, precipitation probability, and conditions summary.' },
        language: { type: 'string', description: 'ISO 639-1 language code for the weather description text (e.g., "en", "es", "fr", "de", "ja"). Defaults to "en".' },
      },
      required: ['location'],
    },
  },
  {
    name: 'search_files',
    description: 'Search for files in the workspace matching a glob pattern or regular expression. Returns an array of matching file paths with metadata including file size in bytes, last modified timestamp, file type (file, directory, symlink), and MIME type when detectable. Supports recursive directory traversal, hidden file inclusion, gitignore-aware filtering, and result limiting. The search is performed relative to the current workspace root directory. For large workspaces, use specific patterns and limit results to avoid performance issues.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Glob pattern or regular expression to match file paths against. Supports standard glob syntax: * (any characters in a single path segment), ** (any characters including path separators for recursive matching), ? (single character), [abc] (character class), {a,b} (alternation). Examples: "**/*.ts" for all TypeScript files, "src/**/test_*.py" for Python test files in src.' },
        max_results: { type: 'number', description: 'Maximum number of results to return. Default is 100. Set lower for faster response times in large repositories. Results are returned in filesystem traversal order.' },
        include_hidden: { type: 'boolean', description: 'Whether to include hidden files and directories (those starting with a dot). Default is false to respect common conventions and avoid returning .git, .env, and other sensitive hidden files.' },
        file_type: { type: 'string', enum: ['file', 'directory', 'symlink', 'any'], description: 'Filter results by file system entry type. Default is "any" which returns all types.' },
        respect_gitignore: { type: 'boolean', description: 'Whether to respect .gitignore rules when searching. Default is true. Set to false to include files that would normally be ignored by git, such as build outputs, node_modules, and generated files.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file from the workspace filesystem. Returns the file content as text with optional line range selection. Supports UTF-8 and common text encodings with automatic detection. For binary files, returns a base64-encoded representation. Large files (over 1MB) are automatically truncated with a warning unless explicit line ranges are specified. Tracks file read history for context management.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative or absolute path to the file to read. Relative paths are resolved from the workspace root. Path traversal outside the workspace is not permitted for security reasons. Supports both forward slashes and backslashes on Windows.' },
        start_line: { type: 'number', description: 'The 1-indexed line number to start reading from. Use with end_line to read a specific range. Useful for large files where you only need a specific section. If omitted, reading starts from the beginning of the file.' },
        end_line: { type: 'number', description: 'The 1-indexed line number to stop reading at (inclusive). If omitted, reads to the end of the file or until the size limit is reached. Must be greater than or equal to start_line.' },
        encoding: { type: 'string', description: 'The character encoding to use when reading the file. Default is "utf-8". Supported encodings include "utf-8", "ascii", "latin1", "utf-16le", "utf-16be". Use "binary" for raw binary content returned as base64.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file in the workspace filesystem. Creates the file if it does not exist, or overwrites the existing content if it does. Automatically creates parent directories as needed. Content is written using UTF-8 encoding by default. Returns a confirmation with the number of bytes written and the absolute path of the written file. Maintains an undo history for the most recent write operation per file path.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative or absolute path where the file should be written. Relative paths are resolved from the workspace root. Parent directories will be created automatically if they do not exist. Path traversal outside the workspace is not permitted.' },
        content: { type: 'string', description: 'The full content to write to the file. For text files, this should be the complete file content including appropriate line endings. Existing file content will be completely replaced unless using insert_at_line mode.' },
        create_directories: { type: 'boolean', description: 'Whether to create parent directories if they do not exist. Default is true. Set to false to fail if the parent directory is missing, which can help catch path typos.' },
        insert_at_line: { type: 'number', description: 'If specified, insert the content at this 1-indexed line number instead of overwriting the entire file. Existing content at and after this line is shifted down. Useful for adding imports, inserting new functions, or adding configuration entries.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'execute_command',
    description: 'Execute a shell command in the workspace environment and return its output. Commands are executed using the system default shell (bash on Linux/macOS, PowerShell on Windows). Supports streaming output for long-running commands. Environment variables from the workspace configuration are available. Commands are executed with a timeout to prevent runaway processes. The working directory defaults to the workspace root but can be overridden. Standard output and standard error are captured separately.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'The shell command to execute. Can include pipes, redirections, environment variable references, and other shell features supported by the default shell. For complex multi-line scripts, consider writing to a temporary file and executing it.' },
        working_directory: { type: 'string', description: 'The directory to execute the command in. Relative paths are resolved from the workspace root. Default is the workspace root directory.' },
        timeout_ms: { type: 'number', description: 'Maximum execution time in milliseconds before the command is forcefully terminated. Default is 30000 (30 seconds). Set higher for long-running operations like builds or test suites. Maximum allowed value is 600000 (10 minutes).' },
        env: { type: 'object', description: 'Additional environment variables to set for the command execution. These are merged with the existing environment, with these values taking precedence. Useful for setting API keys, configuration flags, or test parameters.' },
      },
      required: ['command'],
    },
  },
  {
    name: 'grep_search',
    description: 'Search file contents using regular expressions with support for context lines, file type filtering, and result limiting. Powered by ripgrep for high performance even in very large codebases. Returns matching lines with file paths, line numbers, and optional surrounding context. Respects .gitignore by default. Supports multi-line patterns, case-insensitive matching, word boundary matching, and inverted matching. Results can be filtered by file type, glob pattern, or directory path.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'The regular expression pattern to search for. Uses Rust regex syntax (similar to PCRE). Special characters must be escaped with backslash. Examples: "function\\s+\\w+" to find function declarations, "TODO|FIXME|HACK" to find code annotations, "import.*from" to find ES module imports.' },
        path: { type: 'string', description: 'Directory or file path to search within. Relative to workspace root. Default is "." (entire workspace). Use specific paths to narrow search scope and improve performance.' },
        case_sensitive: { type: 'boolean', description: 'Whether the search should be case-sensitive. Default is true. Set to false for case-insensitive matching, which is useful for searching across languages with different casing conventions.' },
        context_lines: { type: 'number', description: 'Number of context lines to include before and after each match. Default is 0. Set to 2-3 for better understanding of match context. Higher values increase response size.' },
        file_glob: { type: 'string', description: 'Glob pattern to filter which files are searched. Examples: "*.ts" for TypeScript files only, "*.{js,jsx,ts,tsx}" for all JavaScript/TypeScript files, "!*.test.*" to exclude test files.' },
        max_results: { type: 'number', description: 'Maximum number of matching lines to return. Default is 200. Lower values improve response time. Results are returned in file-order within each file and alphabetical order across files.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'git_operations',
    description: 'Perform Git version control operations on the workspace repository. Supports common operations including status, diff, log, blame, branch management, staging, committing, and stashing. All operations are performed in the workspace root directory. Destructive operations (reset, force push, rebase) require explicit confirmation. Returns structured output appropriate for each operation type. Authentication for remote operations uses the configured credential helper.',
    input_schema: {
      type: 'object' as const,
      properties: {
        operation: { type: 'string', enum: ['status', 'diff', 'log', 'blame', 'branch', 'stage', 'commit', 'stash', 'show', 'cherry-pick'], description: 'The Git operation to perform. Each operation accepts specific additional parameters. Status returns modified/staged/untracked files. Diff returns unified diff output. Log returns commit history. Blame returns per-line attribution.' },
        target: { type: 'string', description: 'The target for the operation: file path for diff/blame/stage, branch name for branch operations, commit SHA for show/cherry-pick, stash reference for stash operations. Interpretation depends on the operation type.' },
        options: { type: 'object', description: 'Additional options for the operation. For log: { count: number, author: string, since: string, until: string, grep: string }. For diff: { staged: boolean, stat_only: boolean }. For branch: { create: boolean, delete: boolean, rename: string }. For commit: { message: string, amend: boolean }.' },
      },
      required: ['operation'],
    },
  },
  {
    name: 'refactor_code',
    description: 'Apply automated refactoring operations to source code. Supports renaming symbols across files, extracting functions or methods, inlining variables, moving declarations between files, and converting between code patterns. Uses language-aware parsing via tree-sitter to ensure refactoring operations maintain semantic correctness. Provides a preview of all changes before applying them. Supports TypeScript, JavaScript, Python, Rust, Go, Java, C, and C++. Each refactoring operation returns a structured diff showing all affected files and the specific changes made.',
    input_schema: {
      type: 'object' as const,
      properties: {
        operation: { type: 'string', enum: ['rename', 'extract_function', 'extract_variable', 'inline', 'move', 'convert_pattern'], description: 'The refactoring operation to perform. Rename changes a symbol name across all references. Extract_function pulls a code block into a new named function. Extract_variable assigns an expression to a named variable. Inline replaces a variable with its value. Move relocates a declaration to a different file. Convert_pattern transforms between equivalent code patterns.' },
        file_path: { type: 'string', description: 'The file containing the code to refactor. For cross-file operations like rename, this is the file containing the primary declaration. Related files are discovered automatically through import/reference analysis.' },
        start_line: { type: 'number', description: 'The 1-indexed start line of the code region to refactor. Required for extract_function and extract_variable operations to identify the code block to extract.' },
        end_line: { type: 'number', description: 'The 1-indexed end line of the code region to refactor (inclusive). Required for extract operations.' },
        new_name: { type: 'string', description: 'The new name for rename and extract operations. Must be a valid identifier in the target language. The operation will fail if the new name conflicts with existing declarations in the same scope.' },
        preview_only: { type: 'boolean', description: 'If true, return a preview of the changes without applying them. Default is false. Use this to review complex refactoring operations before committing to them.' },
      },
      required: ['operation', 'file_path'],
    },
  },
]

function buildRequestBody(modelId: string, strategy: Strategy): Record<string, unknown> {
  const isNativeMessages = strategy === 'native-messages'

  // For native-messages, include cache_control with `scope` to match real
  // Claude Code behavior. The proxy strips `scope` before forwarding.
  const system = isNativeMessages
    ? [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral', scope: 'turn' },
        },
      ]
    : SYSTEM_PROMPT

  const tools = isNativeMessages
    ? TOOL_DEFINITIONS.map((tool, i) =>
        // Place cache_control on the last tool to mark the end of the tool block
        i === TOOL_DEFINITIONS.length - 1
          ? { ...tool, cache_control: { type: 'ephemeral' as const, scope: 'turn' as const } }
          : tool,
      )
    : TOOL_DEFINITIONS

  return {
    model: modelId,
    max_tokens: 64,
    system,
    messages: [
      { role: 'user', content: 'Say OK' },
    ],
    tools,
  }
}

function resolveStrategy(model: Model): Strategy {
  const endpoints = new Set(model.supported_endpoints ?? [])
  if (endpoints.has('/v1/messages'))
    return 'native-messages'
  if (endpoints.has('/responses'))
    return 'responses'
  return 'chat-completions'
}

function strategyLabel(strategy: Strategy): string {
  switch (strategy) {
    case 'native-messages':
      return 'via /v1/messages native'
    case 'responses':
      return 'via /responses'
    case 'chat-completions':
      return 'via chat-completions'
    case 'skipped':
      return 'skipped'
  }
}

async function sendRequest(body: Record<string, unknown>): Promise<RequestResult> {
  try {
    const response = await fetch(`${BASE_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    const text = await response.text()
    if (response.status < 200 || response.status >= 300) {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      }
      catch {
        parsed = text
      }
      return {
        httpStatus: response.status,
        inputTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        cacheStatus: 'unknown',
        error: extractErrorMessage(parsed),
      }
    }

    const json = JSON.parse(text)
    const usage = parseAnthropicUsage(json)

    return {
      httpStatus: response.status,
      inputTokens: usage?.input_tokens ?? 0,
      cachedTokens: usage?.cache_read_input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheStatus: classifyCacheStatus(usage),
    }
  }
  catch (error) {
    return {
      httpStatus: 0,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      cacheStatus: 'unknown',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function testModel(modelId: string, provider: Provider): Promise<ModelResult> {
  const models = modelCache.getModels()?.data ?? []
  const model = models.find(m => m.id === modelId)

  if (!model) {
    return {
      modelId,
      provider,
      strategy: 'skipped',
      primeRequest: null,
      repeatRequest: null,
    }
  }

  const strategy = resolveStrategy(model)
  const body = buildRequestBody(modelId, strategy)

  if (!jsonMode) {
    process.stdout.write(`  Testing ${modelId}...\n`)
  }

  // Request 1: Cache-priming (likely MISS)
  const primeRequest = await sendRequest(body)

  // Small delay to let upstream caching settle
  await Bun.sleep(REPEAT_DELAY_MS)

  // Request 2: Cache-hit attempt (likely HIT)
  const repeatRequest = await sendRequest(body)

  return {
    modelId,
    provider,
    strategy,
    primeRequest,
    repeatRequest,
  }
}

function cacheLabel(status: CacheStatus): string {
  switch (status) {
    case 'hit':
      return '→ HIT ✓'
    case 'miss':
      return '→ MISS'
    case 'unknown':
      return '→ ???'
  }
}

/**
 * Whether a model result counts as a success: skipped models pass vacuously,
 * tested models require both the prime and repeat request to return HTTP 200.
 */
function modelSucceeded(result: ModelResult): boolean {
  if (result.strategy === 'skipped')
    return true
  return result.primeRequest?.httpStatus === 200
    && result.repeatRequest?.httpStatus === 200
}

function formatRequestLine(label: string, result: RequestResult): string {
  if (result.error) {
    return `  ${label.padEnd(24)} ERROR: ${result.error}`
  }
  return `  ${label.padEnd(24)} input=${String(result.inputTokens).padStart(5)}  cached=${String(result.cachedTokens).padStart(5)}  output=${String(result.outputTokens).padStart(4)}   ${cacheLabel(result.cacheStatus)}`
}

function printReport(results: Array<ModelResult>): void {
  const W = 62
  const thin = '─'.repeat(W)

  printBanner('Cache Control Smoke Test Report')
  process.stdout.write('\n')

  const providerLabels: Record<Provider, string> = {
    anthropic: 'Anthropic Models',
    openai: 'OpenAI Models',
    gemini: 'Gemini Models',
  }

  for (const provider of ['anthropic', 'openai', 'gemini'] as const) {
    process.stdout.write(`── ${providerLabels[provider]} ${thin.slice(0, W - providerLabels[provider].length - 4)}\n\n`)

    const providerResults = results.filter(r => r.provider === provider)
    for (const result of providerResults) {
      if (result.strategy === 'skipped') {
        process.stdout.write(`${result.modelId.padEnd(28)} [skipped — not in model list]\n\n`)
        continue
      }

      process.stdout.write(`${result.modelId.padEnd(28)} [${strategyLabel(result.strategy)}]\n`)

      if (result.primeRequest) {
        process.stdout.write(`${formatRequestLine('Request 1 (prime):', result.primeRequest)}\n`)
      }
      if (result.repeatRequest) {
        process.stdout.write(`${formatRequestLine('Request 2 (repeat):', result.repeatRequest)}\n`)
      }
      process.stdout.write(`\n`)
    }
  }

  // Summary
  const totalModels = Object.values(TARGET_MODELS).flat().length
  const tested = results.filter(r => r.strategy !== 'skipped').length
  const cacheHits = results.filter(r =>
    r.repeatRequest?.cacheStatus === 'hit'
    || r.primeRequest?.cacheStatus === 'hit',
  ).length
  const allSucceeded = results.every(modelSucceeded)

  process.stdout.write(`── Summary ${thin.slice(0, W - 9)}\n`)
  process.stdout.write(`Models tested: ${tested}/${totalModels}\n`)
  process.stdout.write(`Cache hits observed: ${cacheHits}/${tested}\n`)
  process.stdout.write(`All requests succeeded: ${allSucceeded ? '✓' : '✗'}\n`)
}

async function main() {
  await bootstrapProbe({ silent: jsonMode, timeoutMs: REQUEST_TIMEOUT_MS })

  const server = createServer()
  server.listen(PORT)

  if (!jsonMode) {
    process.stdout.write(`\nServer listening on ${BASE_URL}\n\n`)
  }

  const results: Array<ModelResult> = []

  try {
    for (const provider of ['anthropic', 'openai', 'gemini'] as const) {
      for (const modelId of TARGET_MODELS[provider]) {
        const result = await testModel(modelId, provider)
        results.push(result)
      }
    }
  }
  finally {
    server.stop()
  }

  if (jsonMode) {
    const scopeProbeResult = await probeScopeSupport()
    const allSucceeded = results.every(modelSucceeded) && scopeProbeResult !== 'supported'

    process.stdout.write(`${JSON.stringify({
      generatedAt: new Date().toISOString(),
      results,
      scopeSupport: scopeProbeResult,
      summary: {
        totalModels: Object.values(TARGET_MODELS).flat().length,
        tested: results.filter(r => r.strategy !== 'skipped').length,
        cacheHits: results.filter(r =>
          r.repeatRequest?.cacheStatus === 'hit'
          || r.primeRequest?.cacheStatus === 'hit',
        ).length,
        allSucceeded,
      },
    }, null, 2)}\n`)

    if (!allSucceeded)
      process.exitCode = 1

    return
  }

  printReport(results)

  const anyFailure = results.some(r => !modelSucceeded(r))

  if (anyFailure) {
    process.exitCode = 1
  }

  // ── Upstream scope support probe ──
  const scopeProbeResult = await probeScopeSupport()
  if (scopeProbeResult === 'supported') {
    process.stdout.write(
      '\n⚠ FAIL: Copilot now accepts cache_control.scope!\n'
      + '  → Remove sanitizeCacheControl workaround in src/routes/messages/strategy-registry.ts\n\n',
    )
    process.exitCode = 1
  }
  else if (scopeProbeResult === 'rejected') {
    process.stdout.write('\ncache_control.scope: still rejected upstream (filter still needed)\n')
  }
  else {
    process.stdout.write('\ncache_control.scope: probe skipped (no native-messages model available)\n')
  }
}

/**
 * Probe whether the upstream Copilot API accepts `cache_control.scope`
 * by sending a request directly (bypassing proxy sanitization).
 *
 * Returns 'supported' if the upstream accepts scope (meaning we should
 * remove the sanitizeCacheControl workaround), 'rejected' if it still
 * rejects scope, or 'skipped' if no suitable model is available.
 */
async function probeScopeSupport(): Promise<'supported' | 'rejected' | 'skipped'> {
  const models = modelCache.getModels()?.data ?? []
  const model = pickFirstMessagesModel(models)
  if (!model)
    return 'skipped'

  const result = await probeMessagesEndpoint({
    model: model.id,
    max_tokens: 1,
    system: [
      { type: 'text', text: 'Reply with OK.', cache_control: { type: 'ephemeral', scope: 'turn' } },
    ],
    messages: [{ role: 'user', content: 'OK' }],
  })

  if (result.status === 'accepted')
    return 'supported'

  if (result.status === 'rejected' && result.errorMessage?.includes('scope'))
    return 'rejected'

  // Other errors (auth, network) — don't fail the test
  return 'skipped'
}

runMain(main)
