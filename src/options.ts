import esm from 'esm-sync';

export type ESMOptions = Parameters<typeof esm>[1];

export interface Options {
  basePath?: string;
  esmOptions?: ESMOptions;
}
