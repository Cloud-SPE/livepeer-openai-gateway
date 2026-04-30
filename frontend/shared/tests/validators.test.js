import { describe, it, expect } from 'vitest';
import {
  array,
  boolean,
  integer,
  isoDate,
  literal,
  nullable,
  number,
  object,
  optional,
  string,
  union,
  ValidationError,
} from '../lib/validators.js';

describe('validators', () => {
  describe('string', () => {
    it('accepts a string', () => {
      expect(string()('hello')).toBe('hello');
    });
    it('rejects non-strings', () => {
      expect(() => string()(42)).toThrow(ValidationError);
      expect(() => string()(null)).toThrow(ValidationError);
    });
    it('enforces maxLength', () => {
      expect(string({ maxLength: 3 })('abc')).toBe('abc');
      expect(() => string({ maxLength: 3 })('abcd')).toThrow(/length > 3/);
    });
    it('enforces pattern', () => {
      const v = string({ pattern: /^sk-/ });
      expect(v('sk-live-x')).toBe('sk-live-x');
      expect(() => v('nope')).toThrow(/pattern/);
    });
  });

  describe('number / integer / boolean', () => {
    it('accepts numbers, rejects NaN/strings', () => {
      expect(number()(3.14)).toBe(3.14);
      expect(() => number()(NaN)).toThrow();
      expect(() => number()('1')).toThrow();
    });
    it('integer rejects floats', () => {
      expect(integer()(7)).toBe(7);
      expect(() => integer()(7.5)).toThrow();
    });
    it('boolean rejects truthy non-bools', () => {
      expect(boolean()(true)).toBe(true);
      expect(() => boolean()(1)).toThrow();
    });
  });

  describe('isoDate', () => {
    it('accepts ISO strings', () => {
      expect(isoDate()('2026-04-26T08:00:00Z')).toMatch(/2026-04-26/);
    });
    it('rejects invalid', () => {
      expect(() => isoDate()('not-a-date')).toThrow();
      expect(() => isoDate()(0)).toThrow();
    });
  });

  describe('literal', () => {
    it('accepts one of the values', () => {
      const tier = literal('free', 'prepaid');
      expect(tier('free')).toBe('free');
      expect(tier('prepaid')).toBe('prepaid');
    });
    it('rejects others', () => {
      const tier = literal('free', 'prepaid');
      expect(() => tier('enterprise')).toThrow(/free\|prepaid/);
    });
  });

  describe('optional / nullable', () => {
    it('optional permits null and undefined → null', () => {
      const o = optional(string());
      expect(o(null)).toBeNull();
      expect(o(undefined)).toBeNull();
      expect(o('x')).toBe('x');
    });
    it('nullable permits null but not undefined', () => {
      const n = nullable(string());
      expect(n(null)).toBeNull();
      expect(() => n(undefined)).toThrow();
    });
  });

  describe('array', () => {
    it('validates each element', () => {
      expect(array(number())([1, 2, 3])).toEqual([1, 2, 3]);
    });
    it('reports per-index path on failure', () => {
      try {
        array(number())([1, 'bad', 3]);
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationError);
        expect(e.message).toMatch(/\[1\]/);
      }
    });
  });

  describe('object', () => {
    const userShape = object({
      id: string(),
      tier: literal('free', 'prepaid'),
      remaining: nullable(number()),
    });

    it('validates nested fields', () => {
      const out = userShape({ id: 'u1', tier: 'free', remaining: 100 });
      expect(out).toEqual({ id: 'u1', tier: 'free', remaining: 100 });
    });

    it('reports field path on failure', () => {
      try {
        userShape({ id: 'u1', tier: 'wrong', remaining: null });
      } catch (e) {
        expect(e.message).toMatch(/tier/);
      }
    });

    it('rejects non-objects', () => {
      expect(() => userShape(null)).toThrow();
      expect(() => userShape([])).toThrow();
    });
  });

  describe('union', () => {
    it('accepts any branch', () => {
      const v = union(string(), number());
      expect(v('a')).toBe('a');
      expect(v(1)).toBe(1);
    });
    it('rejects when no branch matches', () => {
      const v = union(string(), number());
      expect(() => v(true)).toThrow(/union match failed/);
    });
  });
});
