import type { Result, SourceError } from "@invest/domain";

export async function retryResult<T>(
  operation: () => Promise<Result<T, SourceError>>,
  options: { readonly maxRetries?: number } = {},
): Promise<Result<T, SourceError>> {
  const maxRetries = options.maxRetries ?? 3;
  let attempt = 0;
  while (true) {
    const result = await operation();
    if (result.ok || !result.error.retryable || attempt >= maxRetries) return result;
    const retryAfter = result.error.retryAfterSeconds;
    const exponential = Math.min(30_000, 250 * (2 ** attempt));
    const waitMs = retryAfter === null
      ? Math.round(exponential * (0.5 + Math.random()))
      : Math.min(30_000, retryAfter * 1000);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    attempt += 1;
  }
}
