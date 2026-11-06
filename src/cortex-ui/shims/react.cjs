// React shim: the DSH page already provides React 18.3.1 through the platform
// module table. The wrapper client.js sets globalThis.__DSH_CORTEX_REACT__ before
// this bundle evaluates, and every vendored Cortex module resolves `react` here
// so the whole ported UI shares the host's single React instance (hooks work).
const react = globalThis.__DSH_CORTEX_REACT__
if (!react) {
  throw new Error('[dsh-cortex] platform React was not injected before the Cortex UI bundle')
}
module.exports = react
