const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const zip = new JSZip();
const distPath = path.join(process.cwd(), 'dist');
const zipPath = path.join(process.cwd(), 'public', 'tamrediano_website.zip');

function addFolderToZip(folderPath, currentZipPath) {
  const files = fs.readdirSync(folderPath);
  for (const file of files) {
    const fullPath = path.join(folderPath, file);
    const stats = fs.statSync(fullPath);
    if (stats.isDirectory()) {
      addFolderToZip(fullPath, `${currentZipPath}${file}/`);
    } else {
      if (file.endsWith('.zip')) {
        console.log(`Skipping ${file}`);
        continue;
      }
      const data = fs.readFileSync(fullPath);
      zip.file(`${currentZipPath}${file}`, data);
    }
  }
}

console.log('Zipping dist folder...');
addFolderToZip(distPath, '');

zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true })
  .pipe(fs.createWriteStream(zipPath))
  .on('finish', function () {
    console.log('tamrediano_website.zip written successfully.');
  });
