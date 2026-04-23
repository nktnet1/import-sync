import { test, expect } from '@jest/globals';
import importSync from '../../src';

test('Empty file', () => {
  expect(importSync('./empty')).toMatchObject({});
});

test('Broken file', () => {
  expect(() => importSync('./broken')).toThrow(Error);
});

test('Literal alias', () => {
  expect(importSync('./literal-alias')).toMatchObject({
    myVar: 1531,
    default: 1531,
    'module.exports': 1531,
    myVarAlias: 1531,
    '  __  :)  __  ': 1531,
    ' 😆 ': 1531,
  });
});

test.each([
  { extension: '', message: 'JavaScript' },
  { extension: '.js', message: 'JavaScript' },
  { extension: '.mjs', message: 'ECMAScript' },
  { extension: '.cjs', message: 'CommonJS' },
  { extension: '.ts', message: 'TypeScript' },
])("Testing extension '$extension' contains message '$message'", ({ extension, message }) => {
  expect(importSync(`./extension${extension}`)).toMatchObject({ message });
});
