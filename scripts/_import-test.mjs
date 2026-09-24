import fs from 'fs';
for (const line of fs.readFileSync('C:\\server\\AlphaCard\\.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
}
try {
    const mod = await import('../app/lib/ebay-orders.ts');
    console.log('keys', Object.keys(mod).slice(0, 12).join(','));
} catch (err) {
    console.error('IMPORT_FAIL', err.message);
}
