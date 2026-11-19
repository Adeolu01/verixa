# Unit Testing Conventions

This guide establishes the conventions, best practices, and architecture for writing unit tests across the Verixa monorepo. It focuses on two core pillars provided by `@verixa/testing-kit`:

1. **Fixtures and Object Mothers** (`@verixa/testing-kit/factories`)
2. **In-Memory Fake Adapters** (`@verixa/testing-kit/fakes`)

---

## 1. Fixtures & Object Mothers (`@verixa/testing-kit/factories`)

Writing unit tests should never require configuring dozens of boilerplate fields or wrestling with internal invariants when only a specific behavior is under test. Verixa uses the **Object Mother** pattern (via factory functions) to generate valid domain aggregates, entities, and value objects.

### Factory Principles

1. **Domain Validity by Default:** Calling a factory function without arguments (e.g., `makeUser()`) returns a fully valid, structurally sound entity conforming to all business domain invariants.
2. **Partial Overrides:** Each factory function accepts an optional overrides object. Only provide the fields relevant to the specific test scenario; defaults are provided for everything else.
3. **Invariant Enforcement:** Factories never bypass domain invariants. Where possible, entities are created through standard domain constructors (e.g., `User.register()`, `Session.open()`, `RefreshToken.issue()`). Rehydration (`reconstitute`) is used solely to construct historical, persistence-equivalent states (such as `isRevoked`, deleted, or locked entities) that preserve internal domain invariants.
4. **Isolated & Deterministic:** Factories use incrementing counters or predictable timestamps to ensure tests remain deterministic and free of collisions.

### Available Factories

All factories are exported from `@verixa/testing-kit/factories`:

| Factory                        | Target Entity / Aggregate            | Key Overrides                                                                         |
| :----------------------------- | :----------------------------------- | :------------------------------------------------------------------------------------ |
| `makeUser()`                   | `User` (identity)                    | `id`, `email`, `displayName`, `personName`, `status`, `createdAt`, `updatedAt`        |
| `makeOrganization()`           | `Organization` (identity)            | `id`, `name`, `slug`, `ownerId`, `status`, `createdAt`, `updatedAt`                   |
| `makeOrganizationMembership()` | `OrganizationMembership` (identity)  | `id`, `userId`, `organizationId`, `status`, `joinedAt`                                |
| `makeInvitation()`             | `Invitation` (identity)              | `id`, `organizationId`, `email`, `invitedByUserId`, `ttlMs`                           |
| `makeSession()`                | `Session` (sessions)                 | `id`, `userId`, `policy`, `metadata`, `isRevoked`, `revokedAt`, `now`                 |
| `makeRefreshToken()`           | `IssuedRefreshToken` (sessions)      | `sessionId`, `expiresAt`, `now`                                                       |
| `makeCredential()`             | `Credential` (credentials)           | `id`, `userId`, `passwordHash`, `failedAttempts`, `lockedUntil`                       |
| `makeMfaMethod()`              | `MfaMethod` (mfa)                    | `id`, `userId`, `type`, `status`, `secret`, `now`                                     |
| `makeAuditEvent()`             | `AuditEvent` (audit)                 | `id`, `actorId`, `action`, `resourceType`, `resourceId`, `organizationId`, `metadata` |
| `makeVerificationRequest()`    | `VerificationRequest` (verification) | `id`, `subjectUserId`, `organizationId`, `type`                                       |

### Usage Example

```ts
import { describe, it, expect } from "vitest";
import { makeUser, makeSession, makeCredential } from "@verixa/testing-kit/factories";

describe("AuthenticationService", () => {
  it("rejects authentication when user is suspended", async () => {
    // Generates a suspended user without manual state manipulation
    const user = makeUser({ status: "suspended" });
    const credential = makeCredential({ userId: user.id });

    const result = await authService.authenticate({
      email: user.email.value,
      password: "correct-password",
    });

    expect(result.isErr()).toBe(true);
    expect(result.error).toEqual({ code: "USER_SUSPENDED" });
  });

  it("handles revoked sessions properly", async () => {
    const session = makeSession({ isRevoked: true });
    expect(session.isRevoked).toBe(true);
  });
});
```

### Anti-Patterns to Avoid

- **Ad-hoc Raw Literals:** Do not manually assemble object literals representing domain entities. Always use the factory functions.
- **Bypassing Domain Guards:** Do not use `as any` or type assertions to produce illegal domain states that cannot exist at runtime.
- **Global Mutable Fixtures:** Never share a single instantiated entity across tests. Each test should call the factory to obtain its own clean instance.

---

## 2. Test Doubles & In-Memory Fake Registry (`@verixa/testing-kit/fakes`)

Verixa follows Ports and Adapters (Hexagonal Architecture). Application use cases depend strictly on abstract repository and service ports. For unit testing, we prefer **In-Memory Fakes** over mocks or stubs.

### Fakes vs. Mocks vs. Stubs

- **Stubs:** Return hardcoded responses without state. Useful for fixed responses (e.g., returning the current time or a constant configuration).
- **Mocks:** Expect specific method calls and verify interactions. They tightly couple tests to implementation details and refactorings.
- **Fakes (Recommended):** Fully functional, stateful, in-memory implementations of the port (typically backed by a `Map`). They simulate real repository and adapter behavior without requiring network, disk, or database I/O.

### Compliant Fake Checklist

Every fake adapter in Verixa must satisfy the following checklist:

1. **Faithful Port Implementation:** Implements 100% of the methods declared in the application port interface.
2. **Stateful & Realistic:** Maintains an internal collection (such as `Map<string, Entity>`) that stores and retrieves data consistently.
3. **Deterministic:** Produces identical outputs for identical inputs, independent of wall-clock time or external network conditions.
4. **Resettable:** Provides a `clear()` or `reset()` method so test fixtures can be cleaned up between test cases if shared in a suite.
5. **Standard Naming Convention:** Named `InMemory<PortName>` (e.g., `InMemoryUserRepository`, `InMemorySessionRepository`, `InMemoryRateLimiter`).

### Central Fake Registry

Rather than duplicating fake implementations across different packages, `@verixa/testing-kit/fakes` serves as the centralized registry re-exporting in-memory adapters and test doubles across all bounded contexts:

- **Identity:** `InMemoryUserRepository`, `InMemoryOrganizationRepository`, `InMemoryOrganizationMembershipRepository`, `InMemoryInvitationRepository`, `InMemoryApiKeyRepository`, `InMemoryUnitOfWork`
- **Sessions:** `InMemorySessionRepository`, `InMemoryRevocationList`, `InMemorySessionAuditLogger`
- **Credentials:** `InMemoryCredentialRepository`, `InMemoryCredentialsUnitOfWork`, `InMemoryPasswordResetTokenRepository`, `InMemoryEmailVerificationTokenRepository`
- **MFA:** `InMemoryMfaMethodRepository`, `InMemoryWebAuthnCredentialRepository`, `InMemoryWebAuthnChallengeRepository`, `InMemoryDomainEventPublisher`
- **Authorization:** `InMemoryRoleRepository`, `InMemoryPolicyRepository`, `InMemoryPermissionRepository`, `InMemoryUserRoleAssignmentRepository`
- **Audit:** `InMemoryAuditLogRepository`, `InMemoryAuditEventReader`, `InMemoryAnchorRecordRepository`
- **Verification:** `InMemoryVerificationRequestRepository`
- **Infrastructure / Security:** `InMemoryRateLimiter`, `InMemoryCaptchaService`, `InMemoryBruteForceAttemptStore`, `InMemoryEventPublisher`

### Usage Example

```ts
import { describe, it, beforeEach, expect } from "vitest";
import { makeUser } from "@verixa/testing-kit/factories";
import {
  InMemoryUserRepository,
  InMemorySessionRepository,
  InMemoryRateLimiter,
} from "@verixa/testing-kit/fakes";
import { LoginUseCase } from "./login-use-case.js";

describe("LoginUseCase", () => {
  let userRepo: InMemoryUserRepository;
  let sessionRepo: InMemorySessionRepository;
  let rateLimiter: InMemoryRateLimiter;
  let useCase: LoginUseCase;

  beforeEach(() => {
    userRepo = new InMemoryUserRepository();
    sessionRepo = new InMemorySessionRepository();
    rateLimiter = new InMemoryRateLimiter();

    useCase = new LoginUseCase({
      userRepository: userRepo,
      sessionRepository: sessionRepo,
      rateLimiter,
    });
  });

  it("authenticates and creates a new session in repository", async () => {
    const user = makeUser();
    await userRepo.save(user);

    const result = await useCase.execute({
      email: user.email.value,
      ipAddress: "192.168.1.1",
    });

    expect(result.isOk()).toBe(true);
    const sessions = await sessionRepo.findByUserId(user.id);
    expect(sessions).toHaveLength(1);
  });
});
```
