// Shown for every route except About when the page is not inside the loader (a plain static host, a preview).
import { STATE } from '../strings.js';
import { stateCard, link } from './common.js';

export function mount(ctx, route, container) {
  container.append(stateCard('', STATE.standalone, [link(ctx, '/about', 'Read what this can and cannot do', 'btn primary')]));
  return { title: ctx.flags.appName };
}
