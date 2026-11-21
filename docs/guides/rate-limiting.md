# Rate Limiting Guide

This guide describes Verixa's rate-limiting architecture, strategy selection rules, threat models, and integration patterns across sensitive endpoints such as authentication, password resets, registration, and administrative operations.

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
