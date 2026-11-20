import { expect, it } from 'vitest';
import { redactSecrets } from './redact';

it.each([
  ['Authorization: Bearer abcdef0123456789abcdef', 'Authorization: Bearer [redacted]'],
  ['export OPENAI_API_KEY="abcdefghijklmnop1234"', 'export OPENAI_API_KEY="[redacted]"'],
  ['aws AKIAIOSFODNN7EXAMPLE here', 'aws [redacted] here'],
  ['postgres://admin:hunter2secret@db.internal/app', '[redacted]db.internal/app'],
  [
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'jwt [redacted]',
  ],
  ['-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----', '[redacted]'],
])('redacts %s', (input, expected) => {
  expect(redactSecrets(input)).toBe(expected);
});

it('leaves ordinary text, ids and links alone', () => {
  const text =
    'PR #101 at https://github.com/o/r/pull/101 is green; msg_01k9zq8w3h token count 4096, see commit 0123456789abcdef0123';
  expect(redactSecrets(text)).toBe(text);
});
