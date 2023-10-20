import importSync from '../../src';

test('ESM import with default relative path', () => {
  const exampleMjs = importSync('../basic/basic');
  expect(exampleMjs.helloString).toStrictEqual('helloworld');
});

test('ESM import with absolute path', () => {
  const exampleMjs = importSync(`${process.cwd()}/tests/basic/basic`);
  expect(exampleMjs.helloString).toStrictEqual('helloworld');
});

test('ESM import with different base path', () => {
  const exampleMjs = importSync('./tests/basic/basic', { basePath: process.cwd() });
  expect(exampleMjs.helloString).toStrictEqual('helloworld');
});
