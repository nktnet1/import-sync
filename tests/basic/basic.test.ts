import importSync from '../../src';
const basic = importSync('./basic.mjs');

test('ESM import string variable', () => {
  expect(basic.helloString).toStrictEqual('helloworld');
});

test('ESM import primitive number array', () => {
  expect(basic.array).toStrictEqual([1, 2, 3, 4, 5]);
});

test('ESM import shallow object', () => {
  expect(basic.object).toStrictEqual({ key1: 'value1', key2: 2 });
});

test('ESM import function', () => {
  expect(basic.sum(1, 2)).toStrictEqual(3);
});

test('ESM no extension relativePath', () => {
  expect(importSync('./basic').helloString).toStrictEqual('helloworld');
});

test('No such file', () => {
  expect(() => importSync('./unknown/helloworld')).toThrow(Error);
});
