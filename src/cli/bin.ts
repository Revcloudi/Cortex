#!/usr/bin/env node
/**
 * `ctx` executable entry. The actual dispatcher lives in `./index.ts` so tests
 * can import it without executing the CLI. The bundled artifact is
 * `out/cli/ctx.cjs`; packaging scripts rename it to `<install>/bin/ctx.cjs`.
 */
import { main } from './index'

void main(process.argv).then((exitCode) => {
  process.exitCode = exitCode
})
