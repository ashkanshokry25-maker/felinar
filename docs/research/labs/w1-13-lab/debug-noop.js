// `debug` replacement for production bundles: returns a no-op logger (keeps the call sites, drops debug+ms from the bundle)
const noop = () => {}
export default function debug () { return noop }
