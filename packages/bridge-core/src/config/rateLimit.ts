export interface RateLimitPolicy {
  readonly name: string;
  readonly perMinute: number;
  readonly perDay: number;
  readonly concurrent: number;
}

export interface RateLimitConfig {
  readonly policies: ReadonlyMap<string, RateLimitPolicy>;
  readonly fallbackPolicyName: string;
}

const V1_POLICIES: RateLimitPolicy[] = [
  { name: 'free-default', perMinute: 3, perDay: 200, concurrent: 1 },
  { name: 'prepaid-default', perMinute: 60, perDay: 10_000, concurrent: 10 },
];

export function defaultRateLimitConfig(): RateLimitConfig {
  return {
    policies: new Map(V1_POLICIES.map((p) => [p.name, p])),
    fallbackPolicyName: 'prepaid-default',
  };
}

export function resolvePolicy(config: RateLimitConfig, policyName: string): RateLimitPolicy {
  return (
    config.policies.get(policyName) ??
    config.policies.get(config.fallbackPolicyName) ??
    V1_POLICIES[0]!
  );
}
