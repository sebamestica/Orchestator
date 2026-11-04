import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slug.mjs';

test('slugify maneja cadenas vacías', () => {
  assert.equal(slugify(''), '');
});

test.todo('slugify convierte texto a minúsculas y reemplaza espacios por guiones');
test.todo('slugify elimina caracteres especiales y acentos');
