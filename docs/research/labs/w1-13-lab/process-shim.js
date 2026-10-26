// Same job as webpack's ProvidePlugin({ process: '/polyfills/process-fast.js' }) in webtorrent/scripts/browser.webpack.js
import * as process from '../../../../node_modules/webtorrent/polyfills/process-fast.js'
export { process }
