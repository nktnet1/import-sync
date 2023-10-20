import importSync from '../../src';

test('ESM import with default options', () => {
  const exampleMjs = importSync('../basic/basic');
  expect(exampleMjs.helloString).toStrictEqual('helloworld');
});

test('ESM import with different base path', () => {
  const exampleMjs = importSync('./tests/basic/basic', { basePath: process.cwd() });
  expect(exampleMjs.helloString).toStrictEqual('helloworld');
});
