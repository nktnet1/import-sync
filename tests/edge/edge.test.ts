import importSync from '../../src';

test('Empty file', () => {
  expect(importSync('./empty')).toMatchObject({});
});

test('Broken file', () => {
  expect(() => importSync('./broken')).toThrow(Error);
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
