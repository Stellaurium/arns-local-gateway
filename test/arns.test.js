import test from 'node:test';
import assert from 'node:assert/strict';
import { extractArnsFromHost, normalizeArnsInput, validateArnsName } from '../src/arns.js';

const gateways = ['ar.anyone.tech', 'ar.io', 'arweave.dev'];

test('normalizes common ArNS inputs', () => {
  assert.deepEqual(normalizeArnsInput('sample-site', gateways), { name: 'sample-site', path: '/' });
  assert.deepEqual(normalizeArnsInput('sample-site.ar', gateways), { name: 'sample-site', path: '/' });
  assert.deepEqual(normalizeArnsInput('ar://sample-site/news?id=1', gateways), { name: 'sample-site', path: '/news?id=1' });
  assert.deepEqual(
    normalizeArnsInput('https://sample-site.ar.anyone.tech/archive?q=1', gateways),
    { name: 'sample-site', path: '/archive?q=1' }
  );
  assert.deepEqual(normalizeArnsInput('sam.arweave.dev', gateways), { name: 'sam', path: '/' });
});

test('accepts undernames and rejects unsafe hostnames', () => {
  assert.equal(validateArnsName('app_sample'), true);
  assert.equal(validateArnsName('-bad'), false);
  assert.equal(validateArnsName('bad.example'), false);
  assert.equal(validateArnsName('a'.repeat(43)), false);
});

test('extracts a name from localhost subdomains', () => {
  assert.equal(extractArnsFromHost('sample-site.localhost:4318', 'localhost'), 'sample-site');
  assert.equal(extractArnsFromHost('localhost:4318', 'localhost'), null);
  assert.equal(extractArnsFromHost('evil.example:4318', 'localhost'), null);
});
