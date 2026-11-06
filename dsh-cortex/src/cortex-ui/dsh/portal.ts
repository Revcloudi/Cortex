// Portal host for the ported Cortex UI.
//
// The whole Cortex app renders inside a Shadow DOM so its Tailwind stylesheet
// (including preflight) can never leak into the DSH shell. Radix Dialog/Select/
// Tooltip normally portal into document.body — outside the shadow root — so the
// vendored primitives ask for this container instead.
let container = null

export function setPortalContainer(element) {
  container = element
}

export function getPortalContainer() {
  if (!container) throw new Error('[dsh-cortex] portal container is not mounted yet')
  return container
}

/** Clipboard fallback needs a real document body; keep a helper for that. */
export function getDocumentBody() {
  return document.body
}
