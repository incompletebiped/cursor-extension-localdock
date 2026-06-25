import { describe, it, expect } from 'vitest';
import { isValidDbIdentifier, sanitizeDbName, isSafePath } from '../utils/pathUtils';

describe('isValidDbIdentifier', () => {
  it('accepts alphanumeric and underscore', () => {
    expect(isValidDbIdentifier('my_db')).toBe(true);
    expect(isValidDbIdentifier('user123')).toBe(true);
    expect(isValidDbIdentifier('DB_NAME')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidDbIdentifier('')).toBe(false);
  });

  it('rejects hyphens', () => {
    expect(isValidDbIdentifier('my-db')).toBe(false);
  });

  it('rejects shell metacharacters', () => {
    expect(isValidDbIdentifier("user';DROP TABLE")).toBe(false);
    expect(isValidDbIdentifier('user$(whoami)')).toBe(false);
    expect(isValidDbIdentifier('user`id`')).toBe(false);
  });

  it('rejects spaces', () => {
    expect(isValidDbIdentifier('my db')).toBe(false);
  });

  it('rejects dots', () => {
    expect(isValidDbIdentifier('my.db')).toBe(false);
  });
});

describe('sanitizeDbName', () => {
  it('converts domain to valid identifier', () => {
    expect(sanitizeDbName('example.com')).toBe('example_com');
  });

  it('replaces hyphens', () => {
    expect(sanitizeDbName('my-site.example.com')).toBe('my_site_example_com');
  });

  it('truncates at 64 characters', () => {
    const long = 'a'.repeat(70);
    expect(sanitizeDbName(long).length).toBeLessThanOrEqual(64);
  });

  it('replaces all non-alphanumeric-underscore chars', () => {
    expect(sanitizeDbName('site@host!com')).toBe('site_host_com');
  });
});

describe('isSafePath', () => {
  it('accepts normal relative paths', () => {
    expect(isSafePath('wp-content/uploads/image.jpg')).toBe(true);
    expect(isSafePath('themes/mytheme/style.css')).toBe(true);
  });

  it('rejects path traversal with ..', () => {
    expect(isSafePath('../etc/passwd')).toBe(false);
    expect(isSafePath('uploads/../../etc/passwd')).toBe(false);
  });

  it('rejects absolute paths', () => {
    expect(isSafePath('/etc/passwd')).toBe(false);
  });
});
