// Compile the vendored Cortex memory-graph builder (and the shared contract
// modules the Host adapter reuses) into plain ESM the plugin Host can import.
//
// Why this script exists:
//  - the original builder lives at `src/core/graph/buildMemoryGraph.ts` and
//    imports `../../shared/*`; the vendored copy was moved to
//    `src/cortex-ui/graph/` but intentionally kept verbatim, so its relative
//    imports must be remapped to the vendored `src/cortex-ui/shared/*` files;
//  - `src/cortex-ui/shared/internal.ts` (and `types.ts`, which re-exports it)
//    imports `zod` at runtime, so `zod` must be bundled instead of marked
//    external — the installed plugin has no root `node_modules` dependency on
//    the vendored UI tree.
//
// Output (all generated, never hand-edited):
//   src/host/cortex/graph-builder.js   — ESM exporting `buildMemoryGraph` (etc.)
//   src/host/cortex/shared/types.js    — AssetContext mappers / contract helpers
//   src/host/cortex/shared/internal.js — maskSecret / heatmap / suggestions
//   src/host/cortex/shared/graph.js    — graph node/link contract constants
import { build } from 'esbuild'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const uiRoot = join(root, 'src', 'cortex-ui')
const outDir = join(root, 'src', 'host', 'cortex')
const sharedDir = join(uiRoot, 'shared')
mkdirSync(outDir, { recursive: true })

const sharedNames = new Set(['graph', 'types', 'internal', 'poc', 'repeater'])

/**
 * Remap the original Cortex relative imports to the vendored `src/cortex-ui`
 * tree. The builder was vendored verbatim, so `../../shared/graph` (valid at
 * `src/core/graph/`) is now one directory off; only the *runtime* import needs
 * remapping — `import type` statements are erased by esbuild before resolution.
 */
const vendoredSharedPlugin = {
  name: 'vendored-shared',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^\.\.\/(?:\.\.\/)?shared\/([a-z]+)$/ }, (args) => {
      const name = args.path.split('/').pop()
      if (!sharedNames.has(name)) return null
      return { path: join(sharedDir, `${name}.ts`) }
    })
    // `import type { DatabaseService } from '../db/DatabaseService'` is erased at
    // build time; this stub only guards against a future value import turning the
    // builder into something that needs the (better-sqlite3) desktop DB service.
    buildApi.onResolve({ filter: /(?:^|\/)db\/DatabaseService$/ }, () => ({
      path: 'database-service-stub',
      namespace: 'cortex-stub',
    }))
    buildApi.onLoad({ filter: /.*/, namespace: 'cortex-stub' }, () => ({
      contents: 'export {}',
      loader: 'js',
    }))
  },
}

const banner =
  '// GENERATED from src/cortex-ui/graph/buildMemoryGraph.ts by scripts/build-host-graph.mjs.\n' +
  '// Do not edit: the Cortex builder is vendored verbatim; adapt the DB adapter instead.\n'

// 1) The graph builder itself: fully bundled ESM (no runtime imports at all).
await build({
  absWorkingDir: root,
  entryPoints: [join(uiRoot, 'graph', 'buildMemoryGraph.ts')],
  bundle: true,
  outfile: join(outDir, 'graph-builder.js'),
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  logLevel: 'warning',
  legalComments: 'none',
  banner: { js: banner },
  plugins: [vendoredSharedPlugin],
})

// 2) Shared contract modules the Host adapter imports for exact-shape mapping
//    (AssetContext normalization, secret masking, heatmap / suggestion rules).
await build({
  absWorkingDir: root,
  entryPoints: [
    join(sharedDir, 'graph.ts'),
    join(sharedDir, 'types.ts'),
    join(sharedDir, 'internal.ts'),
  ],
  bundle: true,
  outdir: join(outDir, 'shared'),
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  logLevel: 'warning',
  legalComments: 'none',
  banner: {
    js:
      '// GENERATED from src/cortex-ui/shared/*.ts by scripts/build-host-graph.mjs.\n' +
      '// Do not edit: adapt the Host code instead.\n',
  },
})

/** Fail loudly when the output is not actually importable/complete. */
async function verify() {
  const builderPath = join(outDir, 'graph-builder.js')
  const builderSource = readFileSync(builderPath, 'utf8')
  for (const forbidden of ['from "zod"', "from 'zod'", 'require("zod")', "require('zod')"]) {
    if (builderSource.includes(forbidden)) {
      throw new Error(`graph-builder.js still imports zod externally (${forbidden})`)
    }
  }
  const builder = await import(pathToFileURL(builderPath).href)
  const buildMemoryGraph = builder.buildMemoryGraph
  if (typeof buildMemoryGraph !== 'function') {
    throw new Error('graph-builder.js does not export buildMemoryGraph()')
  }
  const shared = await import(pathToFileURL(join(outDir, 'shared', 'types.js')).href)
  for (const name of ['normalizeAssetInterfaces', 'interfaceDirFromInterfaces', 'deriveAssetHost']) {
    if (typeof shared[name] !== 'function') {
      throw new Error(`shared/types.js does not export ${name}()`)
    }
  }
  const internal = await import(pathToFileURL(join(outDir, 'shared', 'internal.js')).href)
  for (const name of ['maskSecret', 'buildSubnetHeatmap', 'buildCredentialSuggestions']) {
    if (typeof internal[name] !== 'function') {
      throw new Error(`shared/internal.js does not export ${name}()`)
    }
  }

  const size = (path) => (readFileSync(path).length / 1024).toFixed(1)
  console.log(
    `graph build OK: graph-builder.js ${size(builderPath)} KiB, ` +
      `shared/types.js ${size(join(outDir, 'shared', 'types.js'))} KiB, ` +
      `shared/internal.js ${size(join(outDir, 'shared', 'internal.js'))} KiB`,
  )
}

await verify()
