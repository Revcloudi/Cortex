// Automatic JSX runtime shim over the platform React (React 18 has no
// react/jsx-runtime in the DSH platform module table).
function platformReact() {
  const react = globalThis.__DSH_CORTEX_REACT__
  if (!react) throw new Error('[dsh-cortex] platform React was not injected')
  return react
}

function jsx(type, props, key) {
  const react = platformReact()
  const nextProps = {}
  if (props) {
    for (const name of Object.keys(props)) nextProps[name] = props[name]
  }
  if (key !== undefined) nextProps.key = key
  return react.createElement(type, nextProps)
}

module.exports = {
  jsx,
  jsxs: jsx,
  jsxDEV: jsx,
  Fragment: platformReact().Fragment,
}
