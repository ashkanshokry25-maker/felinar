// Getting a picture ready in the browser before it is shared: the avatar is scaled to 512 px on the long side and kept under
// 256 KiB (R 3.3, chosen), then handed to mw.files.share({ public: true }), which removes location and camera details and
// shows its own upload card. Browser only (canvas); the sizes it aims for come from config.js.

import { LIMITS } from './config.js';

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file); // the user's own file, shown nowhere: only drawn onto a canvas
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(Object.assign(new Error('E_MEDIA_TYPE'), { code: 'E_MEDIA_TYPE' })); };
    img.src = url;
  });
}
const toBlob = (canvas, type, q) => new Promise((resolve) => canvas.toBlob(resolve, type, q));

/** scaleToAvatar(file) -> a File (JPEG) at most 512 px on the long side and at most 256 KiB, or throws E_MEDIA_TYPE / E_LIMIT. */
export async function scaleToAvatar(file, { px = LIMITS.avatarPx, maxBytes = LIMITS.avatarBytes } = {}) {
  if (!file || !/^image\//.test(file.type)) throw Object.assign(new Error('E_MEDIA_TYPE'), { code: 'E_MEDIA_TYPE' });
  const img = await loadImage(file);
  const scale = Math.min(1, px / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  for (const q of [0.9, 0.8, 0.7, 0.6, 0.5, 0.4]) {
    const blob = await toBlob(canvas, 'image/jpeg', q);
    if (blob && blob.size <= maxBytes) return new File([blob], 'avatar.jpg', { type: 'image/jpeg' });
  }
  throw Object.assign(new Error('E_LIMIT'), { code: 'E_LIMIT' });
}

/** pickKind(file) -> 'image' | 'video' | null from the type the browser reports (the SDK sniffs the bytes again). */
export function pickKind(file) {
  if (!file || typeof file.type !== 'string') return null;
  return /^image\//.test(file.type) ? 'image' : /^video\//.test(file.type) ? 'video' : null;
}
