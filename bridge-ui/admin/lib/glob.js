// Client-side mirror of the engine's glob matcher
// (livepeer-openai-gateway-core/src/service/pricing/glob.ts).
// `*` (zero-or-more) and `?` (exactly-one) wildcards. No regex.
// Used by the rate-card form's pattern-preview to show the operator
// which seeded model names a glob would match in real time.

const cache = new Map();

function compile(glob) {
  const cached = cache.get(glob);
  if (cached) return cached;
  let re = '^';
  for (const ch of glob) {
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  re += '$';
  const compiled = new RegExp(re);
  cache.set(glob, compiled);
  return compiled;
}

export function globMatch(glob, input) {
  return compile(glob).test(input);
}

/** Filter an array of model names to those matching the glob. */
export function matchesOf(glob, candidates) {
  if (!glob) return [];
  return candidates.filter((m) => globMatch(glob, m));
}
