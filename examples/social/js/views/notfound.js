// An address that is none of the app's routes (R 3.7): the exact sentence, and a way back.
import { STATE } from '../strings.js';
import { stateCard, link } from './common.js';

export function mount(ctx, route, container) {
  container.append(stateCard('', STATE.unknownRoute, [link(ctx, '/', 'Back to the timeline', 'btn primary')]));
  return { title: 'Page not found' };
}
