import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { DatabaseSyncer } from '../sync/DatabaseSyncer';

const FROM = 'http://localhost:8080';
const TO = 'https://example.com';

describe('DatabaseSyncer.rewriteLineUrls', () => {
  it('returns line unchanged when from URL is not present', () => {
    const line = 'INSERT INTO wp_options VALUES (1, "siteurl", "https://example.com", "yes");';
    expect(DatabaseSyncer.rewriteLineUrls(line, FROM, TO)).toBe(line);
  });

  it('replaces plain-text URL occurrences', () => {
    const line = `INSERT INTO wp_options VALUES (1, 'siteurl', 'http://localhost:8080', 'yes');`;
    const result = DatabaseSyncer.rewriteLineUrls(line, FROM, TO);
    expect(result).toContain(TO);
    expect(result).not.toContain(FROM);
  });

  it('rewrites URLs inside PHP serialized strings and fixes byte count', () => {
    // s:22:"http://localhost:8080"; — 22 bytes for "http://localhost:8080"
    const from = 'http://localhost:8080';
    const to = 'https://example.com';
    const serialized = `s:${Buffer.byteLength(from, 'utf-8')}:"${from}";`;
    const result = DatabaseSyncer.rewriteLineUrls(serialized, from, to);
    const expectedLen = Buffer.byteLength(to, 'utf-8');
    expect(result).toBe(`s:${expectedLen}:"${to}";`);
  });

  it('handles serialized strings with embedded double quotes', () => {
    // Simulate a serialized string whose content contains a double quote char
    const content = `url("${FROM}/img.png")`;
    const byteLen = Buffer.byteLength(content, 'utf-8');
    const line = `s:${byteLen}:"${content}";`;
    const result = DatabaseSyncer.rewriteLineUrls(line, FROM, TO);
    const replaced = content.replace(new RegExp(FROM.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), TO);
    const expectedLen = Buffer.byteLength(replaced, 'utf-8');
    expect(result).toBe(`s:${expectedLen}:"${replaced}";`);
  });

  it('handles multiple serialized tokens on a single line', () => {
    const s1 = `s:${Buffer.byteLength(FROM, 'utf-8')}:"${FROM}";`;
    const s2 = `s:${Buffer.byteLength(FROM, 'utf-8')}:"${FROM}";`;
    const line = `${s1} some text ${s2}`;
    const result = DatabaseSyncer.rewriteLineUrls(line, FROM, TO);
    expect(result.split(TO).length - 1).toBe(2);
    expect(result).not.toContain(FROM);
  });

  it('handles multi-byte (UTF-8) characters in serialized content', () => {
    const content = `${FROM}/café`;
    const byteLen = Buffer.byteLength(content, 'utf-8');
    const line = `s:${byteLen}:"${content}";`;
    const result = DatabaseSyncer.rewriteLineUrls(line, FROM, TO);
    const replaced = `${TO}/café`;
    const expectedLen = Buffer.byteLength(replaced, 'utf-8');
    expect(result).toBe(`s:${expectedLen}:"${replaced}";`);
  });

  it('skips malformed s:N:" tokens where N exceeds buffer length', () => {
    const line = 's:99999:"short";';
    // Should not throw and should return a usable string
    expect(() => DatabaseSyncer.rewriteLineUrls(line, FROM, TO)).not.toThrow();
  });
});
