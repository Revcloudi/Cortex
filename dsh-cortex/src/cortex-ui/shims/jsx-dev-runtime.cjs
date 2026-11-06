// Dev JSX runtime alias (production builds use jsx-runtime.cjs; some library
// code imports this name behind `process.env.NODE_ENV` branches).
module.exports = require('./jsx-runtime.cjs')
