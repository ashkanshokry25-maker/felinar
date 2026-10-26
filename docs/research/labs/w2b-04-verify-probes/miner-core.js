// Classic-script SHA-256 miner core (own implementation for VERIFY claim 5; digests cross-checked against node:crypto).
// makeMiner(templateBytes, nonceOffset, nonceLen): the preimage is fixed-length; nonce is fixed-width ASCII hex overwritten in place.
(function (g) {
  const K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  const HEX = '0123456789abcdef';
  g.makeMiner = function (template, nonceOffset, nonceLen) {
    const len = template.length;
    const nblocks = ((len + 9 + 63) >> 6);
    const m = new Uint8Array(nblocks * 64);
    m.set(template); m[len] = 0x80;
    const bitLen = len * 8; const dv = new DataView(m.buffer); dv.setUint32(m.length - 4, bitLen >>> 0); dv.setUint32(m.length - 8, Math.floor(bitLen / 4294967296));
    const W = new Uint32Array(64); const H = new Uint32Array(8);
    function hash() {
      H[0]=0x6a09e667;H[1]=0xbb67ae85;H[2]=0x3c6ef372;H[3]=0xa54ff53a;H[4]=0x510e527f;H[5]=0x9b05688c;H[6]=0x1f83d9ab;H[7]=0x5be0cd19;
      for (let b = 0; b < nblocks; b++) {
        const o = b * 64;
        for (let i = 0; i < 16; i++) W[i] = (m[o+4*i]<<24)|(m[o+4*i+1]<<16)|(m[o+4*i+2]<<8)|m[o+4*i+3];
        for (let i = 16; i < 64; i++) {
          const x = W[i-15], y = W[i-2];
          const s0 = ((x>>>7)|(x<<25))^((x>>>18)|(x<<14))^(x>>>3);
          const s1 = ((y>>>17)|(y<<15))^((y>>>19)|(y<<13))^(y>>>10);
          W[i] = (W[i-16] + s0 + W[i-7] + s1) | 0;
        }
        let a=H[0],bb=H[1],c=H[2],d=H[3],e=H[4],f=H[5],gg=H[6],h=H[7];
        for (let i = 0; i < 64; i++) {
          const S1 = ((e>>>6)|(e<<26))^((e>>>11)|(e<<21))^((e>>>25)|(e<<7));
          const ch = (e&f)^(~e&gg);
          const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
          const S0 = ((a>>>2)|(a<<30))^((a>>>13)|(a<<19))^((a>>>22)|(a<<10));
          const maj = (a&bb)^(a&c)^(bb&c);
          const t2 = (S0 + maj) | 0;
          h=gg; gg=f; f=e; e=(d+t1)|0; d=c; c=bb; bb=a; a=(t1+t2)|0;
        }
        H[0]=(H[0]+a)|0;H[1]=(H[1]+bb)|0;H[2]=(H[2]+c)|0;H[3]=(H[3]+d)|0;H[4]=(H[4]+e)|0;H[5]=(H[5]+f)|0;H[6]=(H[6]+gg)|0;H[7]=(H[7]+h)|0;
      }
    }
    function setNonce(n) { for (let i = nonceLen - 1; i >= 0; i--) { m[nonceOffset + i] = HEX.charCodeAt(n & 15); n >>>= 4; } }
    return {
      blocks: nblocks, bytes: len,
      digestHex(n) { setNonce(n); hash(); let s = ''; for (let i = 0; i < 8; i++) s += (H[i] >>> 0).toString(16).padStart(8, '0'); return s; },
      mine(bits, startNonce, maxIters) { // returns hashes tried, or -1
        const sh = 32 - bits; let n = startNonce >>> 0;
        for (let k = 1; k <= maxIters; k++) { setNonce(n); hash(); if ((H[0] >>> sh) === 0) return k; n = (n + 1) >>> 0; }
        return -1;
      }
    };
  };
})(typeof self !== 'undefined' ? self : globalThis);
