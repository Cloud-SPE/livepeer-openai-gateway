/**
 * Tiny runtime-validator combinators. Mirrored by hand against the bridge's
 * server-side Zod schemas; doc-lint diffs field names to keep them honest.
 *
 * Each combinator is `(input) => ParsedT` and throws ValidationError on shape
 * mismatch. Combinators compose: `object({ id: string, balance_usd: number })`.
 */

export class ValidationError extends Error {
  /** @param {string} path @param {string} message */
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = 'ValidationError';
    this.path = path;
  }
}

const fail = (path, message) => { throw new ValidationError(path || '<root>', message); };

export const string = (opts = {}) => (input, path = '') => {
  if (typeof input !== 'string') fail(path, `expected string, got ${typeof input}`);
  if (opts.maxLength !== undefined && input.length > opts.maxLength) fail(path, `length > ${opts.maxLength}`);
  if (opts.pattern && !opts.pattern.test(input)) fail(path, `does not match pattern`);
  return input;
};

export const number = () => (input, path = '') => {
  if (typeof input !== 'number' || Number.isNaN(input)) fail(path, `expected number`);
  return input;
};

export const integer = () => (input, path = '') => {
  if (typeof input !== 'number' || !Number.isInteger(input)) fail(path, `expected integer`);
  return input;
};

export const boolean = () => (input, path = '') => {
  if (typeof input !== 'boolean') fail(path, `expected boolean`);
  return input;
};

export const isoDate = () => (input, path = '') => {
  if (typeof input !== 'string') fail(path, `expected ISO date string`);
  const ms = Date.parse(input);
  if (Number.isNaN(ms)) fail(path, `invalid ISO date`);
  return input;
};

export const literal = (...values) => (input, path = '') => {
  if (!values.includes(input)) fail(path, `expected one of ${values.join('|')}, got ${String(input)}`);
  return input;
};

export const optional = (validator) => (input, path = '') => {
  if (input === null || input === undefined) return null;
  return validator(input, path);
};

export const nullable = (validator) => (input, path = '') => {
  if (input === null) return null;
  return validator(input, path);
};

export const array = (validator) => (input, path = '') => {
  if (!Array.isArray(input)) fail(path, `expected array`);
  return input.map((item, i) => validator(item, `${path}[${i}]`));
};

export const object = (shape) => (input, path = '') => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail(path, `expected object`);
  }
  const out = {};
  for (const key of Object.keys(shape)) {
    out[key] = shape[key](input[key], path ? `${path}.${key}` : key);
  }
  return out;
};

export const union = (...validators) => (input, path = '') => {
  const errors = [];
  for (const v of validators) {
    try { return v(input, path); } catch (e) { errors.push(e); }
  }
  fail(path, `union match failed: ${errors.map((e) => e.message).join(' | ')}`);
};
