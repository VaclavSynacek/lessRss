'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'build', 'lambda');

async function main() {
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(out, { recursive: true });
  await copy(path.join(root, 'src'), path.join(out, 'src'));
  await copy(path.join(root, 'node_modules'), path.join(out, 'node_modules'));
  await copyFile('package.json');
  await copyFile('package-lock.json');
  console.log('Built Lambda package tree at build/lambda');
}

async function copyFile(rel) {
  await fs.copyFile(path.join(root, rel), path.join(out, rel));
}

async function copy(src, dest) {
  const st = await fs.stat(src);
  if (st.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    for (const entry of await fs.readdir(src)) {
      await copy(path.join(src, entry), path.join(dest, entry));
    }
  } else if (st.isFile()) {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
