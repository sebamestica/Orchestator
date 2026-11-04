import { test } from 'node:test';
import assert from 'node:assert/strict';
import { camelCase, snakeCase } from '../src/case.mjs';

test('case maneja cadenas vacías y tipos no string', () => {
  assert.equal(camelCase(''), '');
  assert.equal(camelCase(null), '');
  assert.equal(snakeCase(''), '');
  assert.equal(snakeCase(undefined), '');
});

test('camelCase convierte texto separado por espacios o guiones a camelCase', () => {
  assert.equal(camelCase('hola mundo'), 'holaMundo');
  assert.equal(camelCase('primer-intento-de-prueba'), 'primerIntentoDePrueba');
  assert.equal(camelCase('UsuarioRegistrado'), 'usuarioRegistrado');
  assert.equal(camelCase('  varios   espacios  '), 'variosEspacios');
});

test('snakeCase convierte texto a minúsculas separadas por guiones bajos', () => {
  assert.equal(snakeCase('hola mundo'), 'hola_mundo');
  assert.equal(snakeCase('primer-intento'), 'primer_intento');
  assert.equal(snakeCase('UsuarioRegistrado'), 'usuario_registrado');
  assert.equal(snakeCase('  varios   espacios  '), 'varios_espacios');
});
