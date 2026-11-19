import { beforeEach, describe } from "vitest";

/**
 * An adapter candidate to be evaluated against a port's contract specification.
 */
export interface AdapterImplementation<T> {
  /** Descriptive name of the adapter implementation (e.g., 'NoopCaptchaVerifier'). */
  readonly name: string;
  /** Factory function producing a fresh adapter instance for each test. */
  readonly factory: () => Promise<T> | T;
}

/**
 * Helper to define and execute shared contract tests across multiple adapter implementations.
 *
 * Operationalizes the Liskov Substitution Principle for hexagonal architecture ports:
 * guarantees that all adapters implementing port `T` behave identically from the caller's
 * perspective, covering both normal operations and failure modes (timeouts, malformed responses).
 *
 * @param portName Human-readable name of the port (e.g. 'CaptchaVerifier')
 * @param implementations List of adapter implementations to test
 * @param spec Shared assertion suite run against every adapter
 */
export function defineContractTests<T>(
  portName: string,
  implementations: readonly AdapterImplementation<T>[],
  spec: (getAdapter: () => T) => void,
): void {
  for (const impl of implementations) {
    describe(`${portName} contract: ${impl.name}`, () => {
      let adapter: T;

      beforeEach(async () => {
        adapter = await impl.factory();
      });

      spec(() => adapter);
    });
  }
}
