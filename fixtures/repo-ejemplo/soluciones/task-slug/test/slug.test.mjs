import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slug.mjs';

test('slugify maneja cadenas vacías y tipos no string', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify(null), '');
  assert.equal(slugify(undefined), '');
});

test('slugify convierte texto a minúsculas y reemplaza espacios por guiones', () => {
  assert.equal(slugify('Hola Mundo'), 'hola-mundo');
  assert.equal(slugify('Text Utils Library'), 'text-utils-library');
});

test('slugify elimina caracteres especiales y acentos', () => {
  assert.equal(slugify('¡Atención: café y té!'), 'atencion-cafe-y-te');
  assert.equal(slugify('  espacios   múltiples  '), 'espacios-multiples');
  assert.equal(slugify('---guiones---repetidos---'), 'guiones-repetidos');
});
