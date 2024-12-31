import esm from '@httptoolkit/esm';

export type ESMOptions = Parameters<typeof esm>[1];

export interface Options {
  basePath?: string;
  esmOptions?: ESMOptions;
}
