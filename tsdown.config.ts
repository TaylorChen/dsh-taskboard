/**
 * Two builds: the node half (one entry per cordis row plus the invariant
 * companion) and the browser half.
 *
 * The client artifact replicates the harness's shared client preset
 * (packages/client/tsdown.client.ts): a CJS closure-factory calling
 * `window.__ModuleLoader__.load({ id, factory })`, with platform modules
 * resolved through the injected require (the loader's frozen module table).
 * A purity gate rejects any other `@deepseek-ai` value import — cross-plugin
 * collaboration goes through cordis services, and type-only imports are erased
 * before they reach the gate.
 *
 * This panel ships no CSS: it styles itself with `color-mix` over
 * `currentColor`, so there is no CSS-modules pipeline to maintain.
 */
import { defineConfig } from 'tsdown'
import type { UserConfig } from 'tsdown'

const PLUGIN_ID = '@navidid/dsh-taskboard'

/** Browser platform modules the shell seeds into the frozen module table. */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

const nodeHalf: UserConfig = {
  name: PLUGIN_ID,
  entry: {
    index: 'src/index.ts',
    tool: 'src/tool.ts',
    routes: 'src/routes.ts',
    autoclaim: 'src/autoclaim.ts',
    invariant: 'src/invariant.ts',
  },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: false,
  clean: false,
  // `.js` rather than the bundler default `.mjs`: the package is
  // "type": "module", and the exports map, the cordis rows and the CI path
  // check all name `.js`.
  outExtensions: () => ({ js: '.js' }),
  deps: { neverBundle: [/^@deepseek-ai\//, 'zod'] },
}

const clientHalf: UserConfig = {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...PLATFORM_MODULES],
  noExternal: (id: string) =>
    PLATFORM_MODULES.includes(id as (typeof PLATFORM_MODULES)[number]) ? undefined : true,
  plugins: [{
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (PLATFORM_MODULES.includes(source as (typeof PLATFORM_MODULES)[number])) return null
      throw new Error(
        `client bundle purity: "${source}" is not a platform module — cross-plugin value `
        + 'imports are forbidden; collaborate through cordis services',
      )
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([nodeHalf, clientHalf])
