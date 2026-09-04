import { describe, it, expect } from 'vitest';
import { compilePattern } from './pattern.js';

describe('compilePattern', () => {
  it('compiles a /regex/ form', () => {
    const re = compilePattern('/listening on :\\d+/');
    expect(re).not.toBeNull();
    expect(re!.test('listening on :3000')).toBe(true);
  });

  it('honours flags after the closing slash', () => {
    const re = compilePattern('/HELLO/i');
    expect(re!.test('hello')).toBe(true);
  });

  it('returns null for a /regex/ that does not compile', () => {
    expect(compilePattern('/listening on :30(0/')).toBeNull();
  });

  it('treats a plain string as a literal substring', () => {
    const re = compilePattern('a.b');
    expect(re!.test('a.b')).toBe(true);
    expect(re!.test('axb')).toBe(false);
  });
});
