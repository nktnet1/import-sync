import importSync from '../../src';

test('Can resolve module imports that are pure-esm, e.g. node-fetch', () => {
  expect(importSync('node-fetch').default).toStrictEqual(expect.any(Function));
});

test('Can resolve imports of imports that are pure-esm, e.g. node-fetch', () => {
  expect(importSync('./nodeFetchImport.js')).toStrictEqual({ nodeFetch: expect.any(Function) });
});
