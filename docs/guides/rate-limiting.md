# Rate Limiting Guide

This guide describes Verixa's rate-limiting architecture, strategy selection rules, threat models, and integration patterns across sensitive endpoints such as authentication, password resets, registration, and administrative operations.
This guide details Verixa's rate-limiting architecture, strategy selection, standard HTTP response headers, and client back-off protocols across sensitive endpoints.

---

## Architecture Overview

Rate limiting in Verixa is structured into layered, composable components:

1. **Storage Ports (`RateLimiter`)**: Low-level sliding-window or token-bucket counter storage (e.g. Redis, in-memory) defined in `@verixa/shared-kernel`.
2. **Specialized Strategies**: Dimension-specific domain logic for resolving identities, validating keys, and managing quotas:
   - `IpRateLimitStrategy`: Governs limits keyed to client IP addresses.
   - `AccountRateLimitStrategy`: Governs limits keyed to account identifiers (emails, usernames).
   - `CompositeRateLimitStrategy`: Combines multiple dimensions in defense-in-depth policies.
3. **HTTP Integration Layer**: Route hooks and middleware that evaluate strategies and emit standard rate-limiting response headers.

---

## Strategy Selection

Choosing the correct rate-limiting strategy depends on the specific threat vector and endpoint sensitivity.

| Strategy                                       | Primary Threat Vector                                                                     | Weakness When Used Alone                                                                                                        | Recommended Endpoints                                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **IP-Based** (`IpRateLimitStrategy`)           | Volumetric DoS, single-origin API spam                                                    | Ineffective against distributed botnets / proxy rotation; risks noisy-neighbor throttling behind shared NAT/corporate gateways. | Public unauthenticated reads, health checks, search endpoints, initial static assets.           |
| **Account-Based** (`AccountRateLimitStrategy`) | Distributed credential stuffing, password spray against targeted accounts                 | Ineffective against account-enumeration scans cycling through millions of distinct account names from a single IP.              | Authenticated operations, targeted password resets, account unlocks.                            |
| **Composite** (`CompositeRateLimitStrategy`)   | Multi-vector abuse: botnets hitting single accounts AND single IPs spraying many accounts | Higher resource consumption (evaluates both buckets).                                                                           | Sensitive authentication entrypoints (`/auth/login`, `/auth/register`, `/auth/reset-password`). |

---

## Why Composite Limiting (Defense in Depth)?

In modern web security, **no single dimension is sufficient alone**:

### Attack Scenario 1: Distributed Credential Stuffing (Botnet)

An attacker controls 50,000 residential proxy IPs. Each proxy IP sends only 1 login request per hour targeting a single victim account (`alice@example.com`).

- **IP-only strategy**: Sees 1 request per IP per hour. Completely fails to detect or throttle the attack.
- **Account strategy in Composite**: Tracks attempts on `account:alice@example.com`. Once the account threshold is reached, further attempts are blocked regardless of the attacking IP.

### Attack Scenario 2: Account Enumeration and Spraying

An attacker uses a single host (or small cluster) to test 100,000 distinct usernames against a common password dictionary.

- **Account-only strategy**: Sees only 1 attempt per username. Fails to throttle the attack because every request uses a different account key.
- **IP strategy in Composite**: Tracks requests from the attacking IP. After exceeding the IP threshold, the attacker is blocked from testing additional accounts.

### Judgment Call: Decision Combination Logic

When combining sub-strategies in `CompositeRateLimitStrategy`:

- **Accepted Rule (Strictest Wins)**: If _either_ IP or account strategy denies the request, the composite strategy denies (`allowed = false`).
- **Rejected Alternative (Weighted Scoring / Threshold Summation)**: Summing denial probabilities or assigning weights was rejected because authentication security requires deterministic guarantees: an account undergoing brute force must be shielded even if the IP appears innocent, and an abusive IP must be throttled even if it targets a non-existent account.
- **Auditing Visibility**: The result explicitly annotates `deniedBy` (`"ip" | "account" | "both"`) so security teams and audit logs can distinguish distributed stuffing attacks from localized volumetric abuse without exposing internal state to the untrusted caller.
Rate limiting in Verixa is structured into layered components:

1. **Storage Ports (`RateLimiter`)**: Defined in `@verixa/shared-kernel`, providing sliding-window or token-bucket counter persistence.
2. **Specialized Strategies (`@verixa/rate-limiting`)**:
   - `IpRateLimitStrategy`: Governs limits keyed to client IP addresses with reverse-proxy spoofing protection.
   - `AccountRateLimitStrategy`: Governs limits keyed to account identifiers (emails, usernames).
   - `CompositeRateLimitStrategy`: Multi-dimensional defense-in-depth policy combining IP and account dimensions.
3. **HTTP Header Middleware (`@verixa/api`)**: Fastify hooks that evaluate quotas and emit standard response headers.

---

## HTTP Rate-Limit Response Headers

Rate-limited endpoints communicate bucket status to clients on every evaluated response using standard headers:

| Header                  | Present On                       | Value Format                                   | Description                                                                       |
| ----------------------- | -------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------- |
| `X-RateLimit-Limit`     | All rate-limited routes          | Integer (e.g. `100`)                           | The total request quota allocated to the client/principal in the current window.  |
| `X-RateLimit-Remaining` | All rate-limited routes          | Integer (e.g. `42`)                            | The number of remaining allowed requests before throttling occurs in this window. |
| `X-RateLimit-Reset`     | All rate-limited routes          | Integer Unix epoch seconds (e.g. `1700000030`) | Wall-clock timestamp when the current rate limit window resets.                   |
| `Retry-After`           | **429 (Too Many Requests)** only | Integer delta seconds (e.g. `30`)              | Minimum number of seconds the client must wait before retrying.                   |

---

## Why Standard Headers Reduce Retry Storms (IETF Conventions)

When APIs throttle requests without returning structured back-off parameters, automated clients resort to blind polling or aggressive retry loops. This frequently triggers **retry storms**, where clients retry simultaneously at fixed intervals, amplifying the load and turning a localized spike into a full cascading outage.

### Standardized Back-Off Signals

Emitting `X-RateLimit-*` and `Retry-After` establishes a clear contract:

1. **Predictable Client Throttling**: Clients and SDKs can pace their outbound requests before consuming their final remaining quota.
2. **Deterministic Back-Off**: On receiving HTTP 429, well-behaved clients read `Retry-After` (in seconds) and delay retries according to the server's exact schedule plus jitter, avoiding synchronized thunder-herd spikes.
3. **Observability**: Proxies, gateways, and monitoring dashboards can detect quota exhaustion early from HTTP responses without inspecting application logs or response payloads.

---

## Judgment Calls and Design Decisions

### 1. `X-RateLimit-*` vs Draft IETF `RateLimit-*` Headers

- **Accepted**: Emit the established de facto standard headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`) along with RFC 9110 standard `Retry-After`.
- **Rejected Alternative**: Adopting the draft `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` specification exclusively was rejected because widespread HTTP client libraries, API gateways, SDKs, and developer tooling (Postman, curl scripts, third-party monitoring) expect `X-RateLimit-*`. Once the IETF specification reaches final RFC status and ecosystem ubiquity, dual-header emission can be phased in without breaking existing clients.

### 2. Seconds vs Milliseconds for `Retry-After`

- **Accepted**: Delta seconds rounded up (`Math.ceil((resetAt - now) / 1000)`), with a hard floor of `1` second.
- **Rejected Alternative**: Millisecond resolution or fractional numbers. RFC 9110 Section 10.2.3 explicitly requires `Retry-After` to be a non-negative decimal integer representing seconds (or an HTTP-date). Using fractional seconds or milliseconds breaks HTTP client parsers.

### 3. Presence of `Retry-After` on Successful (200) Requests

- **Accepted**: Omit `Retry-After` on successful responses (`200 OK`).
- **Rejected Alternative**: Emitting `Retry-After: 0` on 200 responses. Some HTTP proxies misinterpret `Retry-After` on non-429/503 responses as an indicator of service degradation or cache invalidation. `Retry-After` is strictly reserved for throttle and back-off responses.
