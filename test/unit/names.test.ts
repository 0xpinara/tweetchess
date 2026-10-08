import { describe, expect, it } from 'vitest';
import { randomDisplayName, sanitizeDisplayName } from '../../shared/names.ts';

describe('display names', () => {
  it('accepts ordinary names and tidies whitespace', () => {
    expect(sanitizeDisplayName('Alice')).toBe('Alice');
    expect(sanitizeDisplayName('  Bold   Rook 27 ')).toBe('Bold Rook 27');
    expect(sanitizeDisplayName("O'Neil-Smith")).toBe("O'Neil-Smith");
    expect(sanitizeDisplayName('Zoë')).toBe('Zoë');
    expect(sanitizeDisplayName('東京')).toBe('東京');
  });

  it.each([
    ['too short', 'A'],
    ['too long', 'x'.repeat(21)],
    ['markup', '<script>alert(1)</script>'],
    ['leading punctuation', '-dash'],
    ['emoji', 'Rook 🏰'],
    ['zero-width characters', 'Al​ice'],
    ['right-to-left override', 'Bob‮evil'],
    ['control characters', 'Bob\u0000'],
    ['not a string', 42],
  ])('rejects %s', (_label, value) => {
    expect(sanitizeDisplayName(value)).toBeNull();
  });

  it('generates valid random names', () => {
    for (let i = 0; i < 50; i++) expect(sanitizeDisplayName(randomDisplayName())).not.toBeNull();
  });
});
