const fs = require('fs');
const path = require('path');
const packageJson = require('../package.json');
const buildId = process.argv[process.argv.length - 1];
if (!/^\d+$/.test(buildId || '')) throw new Error('A numeric beta build ID is required');
packageJson.version += `-beta.${buildId}`;
console.log(packageJson.version);
fs.writeFileSync(path.join(path.resolve('.'), 'package.json'), JSON.stringify(packageJson, null, 2));