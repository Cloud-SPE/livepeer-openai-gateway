export class RateLimitExceededError extends Error {
  constructor(
    public readonly callerId: string,
    public readonly policyName: string,
    public readonly reason: 'per_minute' | 'per_day' | 'concurrent',
    public readonly limit: number,
    public readonly retryAfterSeconds: number,
  ) {
    super(
      `rate limit exceeded for ${callerId} (policy=${policyName}, reason=${reason}, limit=${limit})`,
    );
    this.name = 'RateLimitExceededError';
  }
}
