import importSync from '../../src';

test('ESM no extension relativePath', () => {
  expect(typeof importSync('node-fetch').default).toStrictEqual('function');
});

test('ESM no extension relativePath', () => {
  expect(typeof importSync('node-datachannel').initLogger).toStrictEqual('function');
});
