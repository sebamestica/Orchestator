import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncate } from '../src/truncate.mjs';

test('truncate maneja cadenas vacías y tipos no string', () => {
  assert.equal(truncate('', 10), '');
  assert.equal(truncate(null, 10), '');
  assert.equal(truncate(undefined, 10), '');
  assert.equal(truncate('hola', 0), '');
});

test('truncate devuelve el texto original si no supera maxLength', () => {
  assert.equal(truncate('hola', 10), 'hola');
  assert.equal(truncate('exacto', 6), 'exacto');
});

test('truncate acorta la cadena y añade el sufijo sin exceder maxLength', () => {
  assert.equal(truncate('Hola mundo bonito', 10), 'Hola mu...');
  assert.equal(truncate('Texto largo para acortar', 12, '---'), 'Texto lar---');
  assert.equal(truncate('abcde', 2, '...'), '..');
});
