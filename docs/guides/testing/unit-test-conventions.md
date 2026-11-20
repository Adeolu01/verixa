# Unit Test Conventions

A unit test is a small, executable explanation of one behavior. A reader should
be able to tell what the system was given, what it did, and what observable
result proves the behavior. That matters because tests are read far more often
than they are written: when a test fails months later, its name and setup are
often the first evidence a maintainer has about what the code promised.

This guide covers unit tests in the Verixa TypeScript packages. It complements
[`docs/guides/testing.md`](../testing.md), which explains the workspace's test
runners, integration tests, contract tests, and coverage.

## Name the behavior

Use `describe` for the public unit or behavior under test and `it` for a
sentence describing the outcome. A good name reads like a small specification:
it says what a caller observes, not which private method happened to run.

```ts
describe("Email", () => {
  it("normalizes case and surrounding whitespace", () => {
    const result = Email.create("  Alice@Example.COM  ");

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.value).toBe("alice@example.com");
    }
  });
});
```

Prefer `it("rejects an address with no domain dot", ...)` over `it("works", ...)`,
`it("calls validateEmail", ...)`, or `it("should reject an address", ...)`.
The first wording reports the behavior; the others are vague, describe an
implementation detail, or add a redundant “should.”

Keep the subject in `describe` stable. If a test needs a context such as an
expired token, a nested `describe` may name that condition; the individual `it`
still states what happens there. Avoid nesting solely to mirror the source
file's private function structure.

## Arrange, act, assert

Keep setup, the operation, and the observation in that order. Separate them
with whitespace; comments labeled Arrange/Act/Assert are unnecessary unless a
non-obvious setup needs explanation.

```ts
it("rejects an address with no domain dot", () => {
  // Arrange: the input is syntactically email-like but has no dotted domain.
  const address = "alice@localhost";

  // Act: pass it through the same constructor callers use.
  const result = Email.create(address);

  // Assert: the domain boundary refuses it.
  expect(Result.isErr(result)).toBe(true);
});
```

The operation should be visible once. Avoid computing the result in an
assertion, hiding it in a helper, or repeating the same call to make several
assertions. For a `Result`, assert the relevant branch first, then narrow it
before inspecting its value or error. This keeps a failed branch from turning
into an unrelated property-access exception.

## One behavior per test

Give each test one reason to fail. A test may make several assertions when they
all prove the same behavior—for example, a rejected `Result` and its field
error—but do not use one test as a tour of unrelated success, normalization,
and rejection cases. Separate tests make failures local and names useful.

```ts
// Avoid: the first assertion failure hides which other behavior regressed.
it("handles email addresses", () => {
  expect(Result.isOk(Email.create("alice@example.com"))).toBe(true);
  expect(Result.isErr(Email.create("alice@localhost"))).toBe(true);
});

// Prefer independent examples with independent failure messages.
it("accepts an address with a dotted domain", () => {
  expect(Result.isOk(Email.create("alice@example.com"))).toBe(true);
});

it("rejects an address without a dotted domain", () => {
  expect(Result.isErr(Email.create("alice@localhost"))).toBe(true);
});
```

Do not split a single outcome into many tests merely to keep each test to one
assertion. The rule is one behavior, not one `expect`.

## Use `test.each` for a real input matrix

Use `it.each` or `test.each` when multiple inputs exercise the same behavior
and use the same assertions. Give each row a readable label so a failure says
which case broke.

```ts
it.each([
  ["empty input", ""],
  ["missing at sign", "alice.example.com"],
  ["missing domain dot", "alice@localhost"],
])("rejects %s", (_case, input) => {
  expect(Result.isErr(Email.create(input))).toBe(true);
});
```

Write separate tests when cases have different outcomes, setup, or assertions.
Do not put a long scenario in a table just to reduce line count; the extra
indirection makes the behavior harder to read. Keep tables small and local to
the test that uses them.

## Put fixtures where their reuse is real

Use a small inline value for a simple case. Put a helper in the same
`*.spec.ts` file when several tests in that file need the same meaningful
setup. Keep package-specific shared test support in that package's existing
testing area (for example, `packages/identity/infrastructure/testing/`) when
multiple spec files genuinely share it.

Build domain fixtures through their public constructors and factories. A
fixture should satisfy the same invariants as production data; do not cast a
partial object to a domain type or hand-build private state to make setup
shorter. Name helpers after the value they create, and let callers override
only details relevant to a test.

```ts
function validEmail(raw = "alice@example.com"): Email {
  const result = Email.create(raw);
  if (Result.isErr(result)) {
    throw new Error("Test fixture email must be valid");
  }
  return result.value;
}
```

Do not create a shared factory for a value used once. Repeated setup is a reason
to consider a helper; a hypothetical future reuse is not. Keep test-only
fixtures out of production modules.

## Mock at boundaries

Prefer real domain objects and the smallest fake needed to isolate the unit.
For application use cases, an in-memory implementation of a port often makes
behavior clearer than mocking each repository method. Mock external systems
such as network clients, database drivers, or cryptographic providers at the
boundary where the unit hands work to them.

Do not mock the unit under test, its private methods, or every internal
collaborator. A test that only proves “method X called method Y” can stay green
while the user's outcome is wrong. Assert returned values, state changes, or
externally meaningful effects. Assert a call only when that interaction is
itself part of the contract, such as ensuring a credential is not persisted
after validation fails.

Fakes have limits. The in-memory repositories in
`packages/identity/infrastructure/testing/` do not enforce every database
constraint. Use an integration test against the real adapter when correctness
depends on SQL constraints, transaction behavior, HTTP serialization, or
another boundary that a fake cannot reproduce. Keep those tests in the
existing integration or adapter test area described in
[`testing.md`](../testing.md).

## Time, randomness, and asynchronous work

Tests must not wait for wall-clock time to pass. Do not use `setTimeout`,
`sleep`, or polling delays to make an expiry or retry happen. They make a test
slow and flaky because the scheduler, machine load, and CI runner all affect
when it wakes. Use Vitest fake timers for code that reads the system clock or
schedules timers, and always restore real timers after the test.

```ts
import { Result } from "@verixa/shared-kernel";
import { afterEach, describe, expect, it, vi } from "vitest";

import { JwtTokenSigner } from "./jwt-token-signer.js";
import { SigningKeyProvider } from "./signing-key-provider.js";

describe("JwtTokenSigner", () => {
  const signer = new JwtTokenSigner(
    new SigningKeyProvider({ secret: "test-signing-secret-value" }),
  );

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a token after its expiry time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const token = await signer.sign({ sessionId: "session-1", userId: "user-1" }, 60);

    vi.setSystemTime(new Date("2026-01-01T00:01:01.000Z"));
    const result = await signer.verify(token);

    expect(Result.isErr(result)).toBe(true);
  });
});
```

If production behavior depends on time or random choices, make that dependency
controllable at its boundary and supply a fixed value in the test. Use the
`Clock` port (`now(): Date`) for time and inject an RNG function or small
interface for random choices; avoid reaching for `Date.now()` or
`Math.random()` inside application logic. `@verixa/testing-kit` provides
`FixedClock` (`set` and millisecond `advance`) and `SeededRandom` (`next`, in
`[0, 1)`) for tests that need predictable values. The seeded generator is for
repeatable tests only, never for tokens, keys, or other security-sensitive
randomness. Direct system calls are reasonable at an infrastructure boundary
that adapts the runtime to a port. The PR checklist asks reviewers to notice
new direct calls because a lint ban would also reject those deliberate
adapters. Do not assert on a random result or the exact current clock time. For async code,
`await` the operation and assert its result; do not start detached work and
wait an arbitrary duration for it to finish.

## Avoid brittle tests

Tests should fail when observable behavior regresses, not when an internal
implementation is rearranged. Avoid:

- Reading private fields or calling private helpers instead of using the public
  boundary.
- Asserting incidental call counts, exact SQL, internal object layout, or
  ordering that the contract does not promise.
- Comparing an entire large object when only one meaningful field is relevant.
- Sleeping, using real network services, or relying on the current date in a
  unit test.
- Making assertions on source text, filenames, or the existence of a test
  rather than on behavior.
- Catching an error and asserting only that “something threw” when a specific
  error code or result is part of the contract.

Before writing an assertion, ask: “If the implementation changed but callers
still received the same correct behavior, should this test remain green?” If
yes, assert at that observable boundary. If no because the interaction is a
security or persistence guarantee, explain that contract in the test name or a
short comment.

## Running the suite

Run the focused package test while iterating, then run the workspace checks
before submitting:

```bash
pnpm --filter @verixa/<package> test
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
```

Database-backed integration tests may skip when their documented test database
is unavailable. Report that limitation rather than treating a skip as a pass
for the database behavior.
