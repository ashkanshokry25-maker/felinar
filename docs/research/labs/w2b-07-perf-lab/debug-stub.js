const noop = () => {}; const d = () => noop; d.enabled = () => false; d.enable = noop; d.disable = noop; export default d;
