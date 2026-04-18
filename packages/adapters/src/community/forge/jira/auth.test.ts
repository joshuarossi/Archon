import { describe, test, expect } from 'bun:test';
import { parseAllowedAccountIds, isJiraUserAuthorized } from './auth';

describe('parseAllowedAccountIds', () => {
  test('returns empty array for undefined', () => {
    expect(parseAllowedAccountIds(undefined)).toEqual([]);
  });

  test('returns empty array for empty string', () => {
    expect(parseAllowedAccountIds('')).toEqual([]);
    expect(parseAllowedAccountIds('   ')).toEqual([]);
  });

  test('parses single accountId', () => {
    expect(parseAllowedAccountIds('5b10a2844c20165700ede21g')).toEqual([
      '5b10a2844c20165700ede21g',
    ]);
  });

  test('parses multiple accountIds', () => {
    expect(parseAllowedAccountIds('a1,b2,c3')).toEqual(['a1', 'b2', 'c3']);
  });

  test('trims whitespace', () => {
    expect(parseAllowedAccountIds(' a1 , b2 , c3 ')).toEqual(['a1', 'b2', 'c3']);
  });

  test('does NOT lowercase (accountIds are case-sensitive opaque strings)', () => {
    expect(parseAllowedAccountIds('ABC123,Xyz789')).toEqual(['ABC123', 'Xyz789']);
  });

  test('filters empty segments', () => {
    expect(parseAllowedAccountIds('a1,,b2,')).toEqual(['a1', 'b2']);
  });
});

describe('isJiraUserAuthorized', () => {
  test('open access when allowed list is empty', () => {
    expect(isJiraUserAuthorized('anyone', [])).toBe(true);
  });

  test('open access allows undefined accountId', () => {
    expect(isJiraUserAuthorized(undefined, [])).toBe(true);
  });

  test('rejects undefined accountId with whitelist', () => {
    expect(isJiraUserAuthorized(undefined, ['a1'])).toBe(false);
  });

  test('rejects empty accountId with whitelist', () => {
    expect(isJiraUserAuthorized('', ['a1'])).toBe(false);
    expect(isJiraUserAuthorized('   ', ['a1'])).toBe(false);
  });

  test('authorizes listed accountId (exact match)', () => {
    expect(isJiraUserAuthorized('a1', ['a1', 'b2'])).toBe(true);
    expect(isJiraUserAuthorized('b2', ['a1', 'b2'])).toBe(true);
  });

  test('rejects unlisted accountId', () => {
    expect(isJiraUserAuthorized('mallory', ['a1', 'b2'])).toBe(false);
  });

  test('rejects case-mismatched accountId (case-sensitive)', () => {
    expect(isJiraUserAuthorized('A1', ['a1'])).toBe(false);
  });
});
