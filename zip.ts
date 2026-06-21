import fs from 'fs';
import path from 'path';
import * as archiverModule from 'archiver';

const archiver = (archiverModule as any).default || archiverModule;

const distPath = path.join(process.cwd(), 'dist');
const zipPath = path.join(process.cwd(), 'public', 'tamrediano_website.zip');

console.log('Zipping dist folder to', zipPath);

const output = fs.createWriteStream(zipPath);
const archive = archiver('zip', {
  zlib: { level: 9 }
});

output.on('close', function() {
  console.log(archive.pointer() + ' total bytes');
  console.log('archiver has been finalized and the output file descriptor has closed.');
});

archive.on('error', function(err: any) {
  throw err;
});

archive.pipe(output);
archive.directory(distPath, false); // false means put contents in root of zip
archive.finalize();
