# Contract tests for ports

An adapter is interchangeable only when it preserves the behavior callers
depend on. TypeScript can check that two adapters expose the same methods; it
cannot check that both enforce the same limits, ordering, or failure behavior.
Contract tests express those expectations once and run them against every
implementation, including in-memory fakes.

`@verixa/testing-kit` exports `defineContractTests`. Give it named factories
and a spec that registers ordinary Vitest assertions:

```ts
defineContractTests(
  [
    { name: "in-memory", factory: () => new InMemoryRateLimiter() },
    { name: "redis", factory: () => new RedisRateLimiter(redis) },
  ],
  (port) => {
    it("allows requests up to the limit", async () => {
      expect(await port().consume("user-1")).toMatchObject({ allowed: true });
    });
  },
);
```

The callback receives a getter because each assertion gets a fresh value from
its factory in `beforeEach`. This isolates stateful adapters between tests,
while every adapter still receives the exact same assertions. Factories may be
asynchronous when setup needs a connection or fixture.

Keep the contract focused on the port's caller-visible guarantees. Do not put
adapter-specific implementation details in the shared spec; those belong in
the adapter's own tests. A contract that is too broad becomes a second
implementation of the adapter rather than a check of the boundary.

The alternative is to duplicate similar assertions in each adapter suite.
That looks simpler initially, but the copies drift: a new assertion can land
in one suite and leave fakes falsely reassuring their callers. Sharing the
spec makes that drift visible by construction.
