import { assert as viAssert } from 'vitest';

export function assert(value: unknown, message?: string): asserts value {
  viAssert.ok(value, message);
}

export function assertFalse(value: unknown, message?: string): void {
  viAssert.isFalse(value, message);
}

export function assertEquals<T>(actual: T, expected: T, message?: string): void {
  viAssert.deepEqual(actual, expected, message);
}

export function assertNotEquals<T>(actual: T, expected: T, message?: string): void {
  viAssert.notDeepEqual(actual, expected, message);
}

export function assertExists<T>(value: T, message?: string): asserts value is NonNullable<T> {
  viAssert.isNotNull(value, message);
  viAssert.isDefined(value, message);
}

export function assertStringIncludes(actual: string, expected: string, message?: string): void {
  viAssert.include(actual, expected, message);
}

export async function assertRejects(
  fn: () => unknown | Promise<unknown>,
  errorClass?: new (...args: never[]) => Error,
  msgIncludes?: string,
): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    if (errorClass) viAssert.instanceOf(err, errorClass);
    if (msgIncludes) {
      viAssert.include(err instanceof Error ? err.message : String(err), msgIncludes);
    }
    return err;
  }
  throw new Error('Expected function to reject');
}
