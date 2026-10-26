#!/usr/bin/env node
// tools/keygen.mjs: the site owner's signing key (ARCHITECTURE §10, DESIGN-REVIEW S12).
//
//   node tools/keygen.mjs [--out owner.jwk] [--force]
//
// Writes an extractable ECDSA P-256 private key as a JWK ({ kty, crv, x, y, d }) with file mode
// 0600 and prints only the fingerprint and the owner= value for the pointer. It never prints the
// private key and refuses to overwrite an existing file unless --force is given. Keep the file
// offline (it signs pointers and the ledger's genesis and control blocks); it never goes into a
// browser. Back it up: a lost key means a new ledger id for the site.

import { openSync, writeSync, closeSync, chmodSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { generateKeyPair, exportPrivateJwk, exportPublicKey, fingerprint } from '../src/chain/crypto.js';
import { parseCli, runMain, isMain, ToolError, UsageError, out } from './lib.mjs';

const USAGE = `
Usage: node tools/keygen.mjs [--out owner.jwk] [--force]

Creates the site owner's P-256 signing key as a JWK file with mode 600 and prints its
fingerprint and the owner= value. Refuses to overwrite an existing file without --force.
`;

/**
 * keygen({ out = 'owner.jwk', force = false }) → { file, pub, fingerprint }
 * The key file is created with O_EXCL and mode 0600 (with --force: written to a new temporary
 * file with mode 0600, then renamed over the old one).
 */
export async function keygen({ out: file = 'owner.jwk', force = false } = {}) {
  const target = resolve(file);
  if (existsSync(target) && !force) {
    throw new ToolError(file + ' already exists; refusing to overwrite a signing key (use --force to replace it)');
  }
  const { privateKey, publicKey } = await generateKeyPair({ extractable: true });
  const jwk = await exportPrivateJwk(privateKey);
  const pub = await exportPublicKey(publicKey);
  const text = JSON.stringify(jwk) + '\n';
  mkdirSync(dirname(target), { recursive: true });
  const tmp = force ? join(dirname(target), '.' + Math.random().toString(36).slice(2) + '.jwk.tmp') : target;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600); // the umask can only remove bits; make the mode exact anyway
  if (tmp !== target) renameSync(tmp, target);
  return { file: target, pub, fingerprint: await fingerprint(pub) };
}

async function main(argv) {
  const { flags, positionals } = parseCli(argv, {
    out: { type: 'string', default: 'owner.jwk' },
    force: { type: 'boolean' },
  });
  if (flags.help) {
    out(USAGE.trim());
    return 0;
  }
  if (positionals.length) throw new UsageError('unexpected argument ' + positionals[0]);
  const res = await keygen({ out: flags.out, force: flags.force });
  process.stderr.write('wrote ' + flags.out + ' (mode 600); keep it offline and backed up\n');
  out('fingerprint ' + res.fingerprint);
  out('owner=' + res.pub);
  return 0;
}

if (isMain(import.meta.url)) runMain(main, USAGE);
