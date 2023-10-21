import importSync from '../../src';

test('Empty file', () => {
  expect(importSync('./empty')).toStrictEqual({});
});

test('Broken file', () => {
  expect(() => importSync('./broken')).toThrow(Error);
});
