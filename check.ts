import fs from 'fs';
import path from 'path';

function getSizes(dir: string) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    if (file === 'node_modules' || file === '.git' || file === 'dist') continue;
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      getSizes(fullPath);
    } else {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (content.length > 50000) {
        console.log(`${fullPath}: ${content.length} bytes, ${content.split('\n').length} lines`);
      }
    }
  }
}
getSizes('.');
