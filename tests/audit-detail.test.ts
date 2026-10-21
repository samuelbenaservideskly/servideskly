import './env.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDetail } from '../src/lib/format.js';

// The audit trail's detail column arrives parsed (JSON_COLUMNS); it printed
// "[object Object]" until 21 Oct 2026.
test('an audit detail reads as names and values, never [object Object]', () => {
  assert.equal(formatDetail({ reference: 'INC-000001', withFiles: 2 }), 'reference: INC-000001, withFiles: 2');
  assert.equal(formatDetail('{"role":"agent"}'), 'role: agent', 'text from before still reads');
  assert.equal(formatDetail({ to: { x: 1 }, gone: null }), 'to: {"x":1}, gone: -');
  assert.equal(formatDetail(null), '');
  assert.doesNotMatch(formatDetail({ a: { b: 1 } }), /\[object Object\]/);
});
