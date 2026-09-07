const ANY_PATH_RE = /.*/
const ENCODING_IMPORT_RE = /(?:^|[\\/])gpt-tokenizer[\\/]encoding[\\/]/
const ENCODING_FILE_RE = /[\\/]gpt-tokenizer[\\/]encoding[\\/]/

export const tokenizerBlockPlugin: Bun.BunPlugin = {
  name: 'tokenizer-cost-probe',
  setup(builder) {
    const blockedEncoding = () => ({
      loader: 'js' as const,
      contents: `
        globalThis.__tokenizerProbeState.encodingLoads++;
        export function encode() {
          globalThis.__tokenizerProbeState.encodeCalls++;
          throw new Error('tokenizer encoding invoked by direct Chat generation');
        }
      `,
    })
    builder.onResolve({ filter: ENCODING_IMPORT_RE }, ({ path }) => ({
      namespace: 'tokenizer-cost-probe',
      path,
    }))
    builder.onLoad({ filter: ANY_PATH_RE, namespace: 'tokenizer-cost-probe' }, blockedEncoding)
    builder.onLoad({ filter: ENCODING_FILE_RE }, blockedEncoding)
  },
}
