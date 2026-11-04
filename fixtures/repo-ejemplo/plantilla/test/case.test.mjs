import { test } from 'node:test';
import assert from 'node:assert/strict';
import { camelCase, snakeCase } from '../src/case.mjs';

test('case maneja cadenas vacías', () => {
  assert.equal(camelCase(''), '');
  assert.equal(snakeCase(''), '');
});

test.todo('camelCase convierte texto separado por espacios o guiones a camelCase');
test.todo('snakeCase convierte texto a minúsculas separadas por guiones bajos');
