import importSync from '../../src';

test('Can resolve imports of imports that are pure-esm, e.g. node-fetch', () => {
  expect(importSync('./nodeFetchImport.js')).toStrictEqual({});
});
