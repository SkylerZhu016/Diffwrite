import {build} from 'esbuild';
await build({entryPoints:['entry.mjs'],bundle:true,format:'esm',platform:'node',target:'node24',minify:true,
  legalComments:'eof',banner:{js:'import {createRequire} from "node:module"; const require = createRequire(import.meta.url);'},outfile:'../mcp-sdk.mjs'});
