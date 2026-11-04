import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncate } from '../src/truncate.mjs';

test('truncate maneja cadenas vacías', () => {
  assert.equal(truncate('', 10), '');
});

test.todo('truncate devuelve el texto original si no supera maxLength');
test.todo('truncate acorta la cadena y añade el sufijo sin exceder maxLength');
