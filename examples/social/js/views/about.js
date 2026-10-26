// The About page (R 3.6): the honest-ceiling table and the privacy and storage sentences. The structure is static HTML in
// index.html (so it is checked like any page); this fills in the sentences that must match the loader's wording exactly and the
// follow cap for this device.
import { PRIVACY } from '../strings.js';
import { followCapView } from '../model.js';
import { FOLLOW_CAPS } from '../config.js';

export function mount(ctx, route, container) {
  const tpl = document.getElementById('tpl-about');
  const frag = tpl.content.cloneNode(true);
  for (const span of frag.querySelectorAll('[data-privacy]')) span.textContent = PRIVACY[span.dataset.privacy] || '';
  const cap = frag.getElementById('about-follow-cap');
  if (cap) {
    const v = followCapView(0, ctx.env.deviceClass());
    cap.textContent = 'You can follow up to ' + FOLLOW_CAPS.phone + ' people on a phone and ' + FOLLOW_CAPS.desktop.toLocaleString('en-US') + ' on a computer. This device: ' +
      v.cap.toLocaleString('en-US') + ' (a chosen limit that real-device tests confirm or lower).';
  }
  container.append(frag);
  return { title: 'About' };
}
