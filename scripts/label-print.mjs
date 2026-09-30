import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

// Prints a carrier shipping label onto the Bluetooth thermal printer
// (Y41BT / KNAON, 100mm x 150mm). Packing slips stay on the Canon.
//
//   npm run print-label -- "C:\path\to\label.pdf"
//   npm run print-label -- 14-15198-21993
//   npm run print-label -- "C:\path\to\label.pdf" pdf-only
//
// eBay does not hand this app the label file. Drop the PDF eBay gives you
// into labels\inbox, or into the watch folder (Downloads, or LABEL_WATCH_DIR),
// and the print agent sends it to the label printer. A matching order number
// is found by the tracking number in the file name or in the PDF text.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_PATH = path.join(repoRoot, 'logs', 'printed-labels.json');
const FIT_SCRIPT = path.join(repoRoot, 'scripts', 'fit-shipping-label.py');

function loadEnvLocal() {
    const envPath = path.join(repoRoot, '.env.local');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (match && !process.env[match[1]]) {
            process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
        }
    }
}

function labelPrinterName() {
    return process.env.LABEL_PRINTER_NAME?.trim() || 'Y41BT Label';
}

function inboxDir() {
    return process.env.LABEL_INBOX?.trim() || path.join(repoRoot, 'labels', 'inbox');
}

function downloadsDir() {
    return process.env.LABEL_WATCH_DIR?.trim() || path.join(os.homedir(), 'Downloads');
}

function run(cmd, args) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: 60000 }, (err, stdout, stderr) => {
            resolve({
                code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
                stdout: stdout || '',
                stderr: stderr || err?.message || '',
            });
        });
    });
}

async function fitLabel(src, dest, force) {
    const args = [FIT_SCRIPT, src, dest];
    if (force) args.push('--force');
    const result = await run('python', args);
    return { ok: result.code === 0, skip: result.code === 2, detail: (result.stdout || result.stderr).trim() };
}

async function printPdf(filePath) {
    const sumatra = process.env.SUMATRA_PATH;
    const printer = labelPrinterName();
    if (process.platform === 'win32' && (!sumatra || !fs.existsSync(sumatra))) {
        throw new Error(`SumatraPDF not found at ${sumatra || '(SUMATRA_PATH unset)'}`);
    }
    if (process.platform === 'win32') {
        return new Promise((resolve, reject) => {
            execFile(
                sumatra,
                ['-print-to', printer, '-print-settings', 'fit,portrait,paper=100mm x 150mm', '-silent', '-exit-when-done', filePath],
                { timeout: 60000 },
                (err, _stdout, stderr) => {
                    if (err) reject(new Error(stderr || err.message));
                    else resolve();
                }
            );
        });
    }

    // Linux path — async so we can await the bbox detection pass
    const printer = labelPrinterName();
    const tsplPath = path.join(os.tmpdir(), `thermal-${Date.now()}.bin`);
    const pbmPath = `${tsplPath}.pbm`;
    const btMac = process.env.LABEL_PRINTER_BT_MAC?.trim();
    const btChannel = process.env.LABEL_PRINTER_BT_CHANNEL?.trim() || '1';

    // --- Pass 1: detect actual content bounding box ---
    // gs -sDEVICE=bbox writes "%%BoundingBox: x1 y1 x2 y2" to stderr
    const bboxResult = await run('gs', [
        '-q', '-dBATCH', '-dNOPAUSE', '-dSAFER', '-sDEVICE=bbox', filePath
    ]);
    const bboxMatch = (bboxResult.stderr || '').match(/%%BoundingBox:\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/);

    // Label canvas in PDF points (4" x 6" at 72pt/in)
    const LABEL_W_PT = 4 * 72;   // 288
    const LABEL_H_PT = 6 * 72;   // 432

    let gsRenderArgs;
    if (bboxMatch) {
        const [x1, y1, x2, y2] = bboxMatch.slice(1).map(Number);
        const bboxW = x2 - x1;
        const bboxH = y2 - y1;
        const scale = Math.min(LABEL_W_PT / bboxW, LABEL_H_PT / bboxH);
        const psSetup = `<</PageSize [${LABEL_W_PT} ${LABEL_H_PT}] /ImagingBBox null>> setpagedevice ${scale} ${scale} scale ${-x1} ${-y1} translate`;
        console.log(`[label] bbox ${bboxW.toFixed(0)}x${bboxH.toFixed(0)}pt -> scale ${scale.toFixed(3)}`);
        gsRenderArgs = [
            '-q', '-dQUIET', '-dSAFER', '-dBATCH', '-dNOPAUSE',
            '-sDEVICE=pbmraw', '-r203', '-g816x1218', '-dFIXEDMEDIA',
            `-sOutputFile=${pbmPath}`,
            '-c', psSetup,
            '-f', filePath,
        ];
    } else {
        console.log('[label] no bbox detected, using dPDFFitPage fallback');
        gsRenderArgs = [
            '-q', '-dQUIET', '-dSAFER', '-dBATCH', '-dNOPAUSE',
            '-sDEVICE=pbmraw', '-r203', '-g816x1218', '-dPDFFitPage',
            `-sOutputFile=${pbmPath}`,
            '-c', '<</Install {1.06 1.06 scale -24 -36 translate}>> setpagedevice',
            '-f', filePath,
        ];
    }

    // --- Pass 2: render to PBM raster ---
    await new Promise((resolve, reject) => {
        execFile('gs', gsRenderArgs, { timeout: 60000 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(stderr || err.message));
            if (!fs.existsSync(pbmPath)) return reject(new Error(`Ghostscript failed to generate PBM for ${filePath}. STDOUT: ${stdout} STDERR: ${stderr}`));
            resolve();
        });
    });

    // --- Build TSPL payload ---
    const pbm = fs.readFileSync(pbmPath);
    const dimIdx = pbm.indexOf(Buffer.from('816 1218'));
    const bitmapData = pbm.subarray(dimIdx + 8 + 1);

    // Invert the colors (PBM uses 1=black, but this printer expects 0=black)
    for (let i = 0; i < bitmapData.length; i++) {
        bitmapData[i] = ~bitmapData[i];
    }

    const header = Buffer.from('SIZE 100 mm, 150 mm\r\nGAP 3 mm, 0 mm\r\nCLS\r\nBITMAP 0,0,102,1218,0,');
    const footer = Buffer.from('\r\nPRINT 1,1\r\n');
    const tsplData = Buffer.concat([header, bitmapData, footer]);
    fs.writeFileSync(tsplPath, tsplData);
    try { fs.unlinkSync(pbmPath); } catch {}

    // --- Send to printer ---
    if (btMac) {
        // Direct Bluetooth socket via Python (no root/dialout needed)
        await new Promise((resolve, reject) => {
            const btSendScript = path.join(repoRoot, 'scripts', 'bt-send.py');
            const btProc = spawn('python3', [btSendScript, btMac, btChannel], { stdio: ['pipe', 'pipe', 'pipe'] });
            let btErr = '';
            btProc.stderr?.on('data', (d) => { btErr += String(d); });
            btProc.stdin.write(tsplData);
            btProc.stdin.end();
            btProc.on('close', (code) => {
                try { fs.unlinkSync(tsplPath); } catch {}
                if (code === 0) {
                    console.log(`[label] sent ${tsplData.length} bytes via BT to ${btMac}`);
                    resolve();
                } else {
                    reject(new Error(`BT send failed (exit ${code}): ${btErr.trim()}`));
                }
            });
            btProc.on('error', (e) => {
                try { fs.unlinkSync(tsplPath); } catch {}
                reject(new Error(`bt-send.py spawn error: ${e.message}`));
            });
        });
    } else {
        // Fallback: use lp/CUPS if no BT MAC is configured
        await new Promise((resolve, reject) => {
            execFile('lp', ['-d', printer, tsplPath], { timeout: 30000 }, (err, _out, stderr) => {
                try { fs.unlinkSync(tsplPath); } catch {}
                if (err) reject(new Error(stderr || err.message));
                else resolve();
            });
        });
    }
}

function readState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch {
        return null;
    }
}

function writeState(state) {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function isPdfMagic(filePath) {
    try {
        const buf = Buffer.alloc(4);
        const fd = fs.openSync(filePath, 'r');
        fs.readSync(fd, buf, 0, 4, 0);
        fs.closeSync(fd);
        return buf.toString('ascii') === '%PDF';
    } catch {
        return false;
    }
}

function listPdfs(dir, requireFilter = false) {
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((name) => {
            const lower = name.toLowerCase();
            if (/packing[-_ ]?slip/i.test(name)) return false;
            if (requireFilter) {
                // Downloads folder: must be a .pdf with ebay/label in the name
                return lower.endsWith('.pdf') && (lower.includes('ebay') || lower.includes('label'));
            }
            // Inbox folder: accept .pdf files OR any extensionless file that is actually a PDF
            if (lower.endsWith('.pdf')) return true;
            if (!lower.includes('.')) return isPdfMagic(path.join(dir, name));
            return false;
        })
        .map((name) => path.join(dir, name));
}

function watchedPdfs() {
    const inbox = listPdfs(inboxDir(), false); // Print any PDF placed in the dedicated inbox
    const downloads = listPdfs(downloadsDir(), true); // Strict filter for the noisy Downloads folder
    return [...new Set([...inbox, ...downloads])];
}

async function pdfText(filePath) {
    if (process.platform !== 'win32') {
        const result = await run('pdftotext', [filePath, '-']);
        if (result.stderr) console.error(`[label] pdftotext error on ${path.basename(filePath)}:`, result.stderr);
        
        let text = result.stdout || '';
        
        // If pdftotext returned nothing, it's an image. Fall back to OCR!
        if (!text.trim()) {
            const pngBase = path.join(os.tmpdir(), `ocr-${Date.now()}`);
            await run('pdftoppm', ['-r', '300', '-png', '-singlefile', filePath, pngBase]);
            const pngPath = `${pngBase}.png`;
            if (fs.existsSync(pngPath)) {
                const ocr = await run('tesseract', [pngPath, 'stdout']);
                text = ocr.stdout || '';
                try { fs.unlinkSync(pngPath); } catch {}
            }
        }
        return text;
    }
    const result = await run('python', [
        '-c',
        'import sys,pypdfium2 as p; d=p.PdfDocument(sys.argv[1]); print("\\n".join((pg.get_textpage().get_text_bounded() or "") for pg in d))',
        filePath,
    ]);
    if (result.stderr) console.error(`[label] python pdf error on ${path.basename(filePath)}:`, result.stderr);
    return result.stdout || '';
}

export async function findLabelPdf({ tracking, orderNumber } = {}) {
    const needles = [tracking, orderNumber].filter(Boolean).map((value) => String(value).replace(/\s+/g, ''));
    const files = watchedPdfs().sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const filePath of files.slice(0, 40)) {
        const base = path.basename(filePath).replace(/\s+/g, '');
        if (needles.some((needle) => needle && base.includes(needle))) return filePath;
    }
    if (needles.length === 0) return null;
    for (const filePath of files.slice(0, 15)) {
        const text = (await pdfText(filePath)).replace(/\s+/g, '');
        if (needles.some((needle) => text.includes(needle))) return filePath;
    }
    return null;
}

export async function printShippingLabel({ file, tracking, orderNumber, dry = false, force = false } = {}) {
    loadEnvLocal();
    fs.mkdirSync(inboxDir(), { recursive: true });
    const src = file || (await findLabelPdf({ tracking, orderNumber }));
    if (!src) {
        return {
            printed: false,
            reason: `No shipping-label PDF found for this order. Download it from eBay into ${inboxDir()} or ${downloadsDir()}, then run the command again.`,
        };
    }
    const dest = src; // Bypass the Python cropping script entirely on Linux!
    // The Zebra CUPS driver automatically crops and rasterizes PDFs for us!
    
    if (dry) {
        return { printed: false, pdf: dest, source: src, reason: `PDF only. Not sent to the label printer. Written to ${dest}` };
    }
    await printPdf(dest);
    return { printed: true, source: src, printer: labelPrinterName() };
}

// One scan at a time. A label print takes longer than the 5s poll, and a
// second pass used to send the same PDF again before the first pass recorded it.
let scanBusy = false;
const labelWaiting = new Map();

export function decideLabelScan({ recordedMtime, size, mtime, pending, hash, printedHashes }) {
    if (size === 0) return { type: 'ignore' }; // Ignore 0-byte files (still downloading or corrupt)
    if (recordedMtime === mtime) return { type: 'seen' };
    if (!pending || pending.size !== size || pending.mtime !== mtime) {
        return { type: 'wait', pending: { size, mtime } };
    }
    if (hash && printedHashes?.[hash]) return { type: 'duplicate' };
    return { type: 'print' };
}

function fileHash(filePath) {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
}

export async function scanNewLabels() {
    if (scanBusy) return [];
    scanBusy = true;
    try {
        loadEnvLocal();
        fs.mkdirSync(inboxDir(), { recursive: true });
        const previous = readState();
        const firstRun = !previous;
        const state = previous || {};
        const printedHashes = state.__printedHashes && typeof state.__printedHashes === 'object'
            ? state.__printedHashes
            : {};
        state.__printedHashes = printedHashes;
        const files = watchedPdfs();
        const printedFiles = [];
        for (const filePath of files) {
            let mtime = 0;
            let size = 0;
            try {
                const st = fs.statSync(filePath);
                mtime = st.mtimeMs;
                size = st.size;
            } catch { continue; }
            if (firstRun) {
                // On startup, skip files that already existed before we launched
                // (to avoid reprinting old labels on every restart).
                // BUT: files that arrived in the last 2 minutes are new arrivals —
                // stamp them as "waiting" so they get printed on the next poll.
                const ageMs = Date.now() - mtime;
                if (ageMs > 2 * 60 * 1000) {
                    state[filePath] = mtime; // Old file — skip it
                } else {
                    labelWaiting.set(filePath, { size, mtime }); // Recent — queue it
                }
                continue;
            }
            const pending = labelWaiting.get(filePath);
            const stable = pending && pending.size === size && pending.mtime === mtime;
            const hash = stable ? fileHash(filePath) : null;
            const decision = decideLabelScan({
                recordedMtime: typeof state[filePath] === 'number' ? state[filePath] : undefined,
                size,
                mtime,
                pending,
                hash,
                printedHashes,
            });
            if (decision.type === 'wait') {
                labelWaiting.set(filePath, decision.pending);
                continue;
            }
            labelWaiting.delete(filePath);
            if (decision.type === 'ignore') continue;
            if (decision.type === 'seen') continue;
            if (decision.type === 'duplicate') {
                state[filePath] = mtime;
                continue;
            }
            let result;
            try {
                result = await printShippingLabel({ file: filePath, force: false });
            } catch (err) {
                console.error(`[label] failed to print ${path.basename(filePath)}:`, err.message || err);
                state[filePath] = mtime; // Mark as seen so it doesn't loop forever
                continue;
            }
            
            if (result.printed) {
                printedFiles.push(filePath);
                let doneMtime = mtime;
                try { doneMtime = fs.statSync(filePath).mtimeMs; } catch { /* keep the mtime we printed */ }
                state[filePath] = doneMtime;
                if (hash) printedHashes[hash] = Date.now();
                console.log(`[label] printed ${path.basename(filePath)} on "${result.printer}"`);
            } else if (result.reason && /not a carrier/.test(result.reason)) {
                state[filePath] = mtime;
            } else if (result.reason) {
                console.error(`[label] ${path.basename(filePath)}: ${result.reason}`);
            }
        }
        writeState(state);
        if (firstRun) {
            console.log(`[label] watching ${downloadsDir()} and ${inboxDir()} for shipping labels → "${labelPrinterName()}" (${files.length} already there, left alone)`);
        }
        return printedFiles;
    } finally {
        scanBusy = false;
    }
}

function salesClient() {
    loadEnvLocal();
    return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
}

async function matchLabelToOrder(filePath) {
    const compact = `${path.basename(filePath)}\n${await pdfText(filePath)}`.replace(/\s+/g, '').toUpperCase();
    const { data, error } = await salesClient()
        .from('ebay_sales')
        .select('order_number, tracking_number, printed_at, sale_date, ship_to_name, buyer')
        .order('sale_date', { ascending: false })
        .limit(80);
    if (error) throw new Error(error.message);
    const hits = [];
    for (const row of data ?? []) {
        const tracking = String(row.tracking_number || '').replace(/\s+/g, '').toUpperCase();
        const orderNumber = String(row.order_number || '').replace(/\s+/g, '').toUpperCase();
        const name = String(row.ship_to_name || row.buyer || '').toUpperCase().replace(/[^A-Z]/g, '');
        let score = 0;
        if (orderNumber && compact.includes(orderNumber)) score = 3;
        else if (tracking.length >= 8 && compact.includes(tracking)) score = 3;
        else if (name.length >= 8 && compact.includes(name)) score = 2;
        if (!score) continue;
        if (row.printed_at && Date.now() - new Date(row.printed_at).getTime() < 10 * 60 * 1000) continue;
        hits.push({ orderNumber: row.order_number, score, sale: row.sale_date || '' });
    }
    hits.sort((a, b) => b.score - a.score || (a.sale < b.sale ? 1 : -1));
    return hits[0]?.orderNumber ?? null;
}

function syncRecentOrders() {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
            '--conditions=react-server',
            '--import',
            'tsx',
            path.join(repoRoot, 'scripts', 'sync-recent-sales.mjs'),
        ], { cwd: repoRoot, env: process.env });
        let out = '';
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error('eBay sync timed out'));
        }, 90000);
        child.stdout.on('data', (chunk) => { out += chunk; });
        child.stderr.on('data', (chunk) => { out += chunk; });
        child.on('error', (err) => { clearTimeout(timer); reject(err); });
        child.on('exit', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve(out.trim());
            else reject(new Error(out.trim() || `eBay sync exited ${code}`));
        });
    });
}

export async function orderNumberForLabel(filePath) {
    const existing = await matchLabelToOrder(filePath);
    if (existing) return existing;
    try {
        const synced = await syncRecentOrders();
        console.log(`[label] ${synced}`);
    } catch (err) {
        console.error('[label] could not refresh eBay sales:', err.message || err);
        return null;
    }
    return matchLabelToOrder(filePath);
}

async function trackingForOrder(orderNumber) {
    loadEnvLocal();
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await supabase
        .from('ebay_sales')
        .select('tracking_number')
        .eq('order_number', orderNumber)
        .not('tracking_number', 'is', null)
        .limit(1);
    if (error) throw new Error(error.message);
    return data?.[0]?.tracking_number || null;
}

async function main() {
    loadEnvLocal();
    const args = process.argv.slice(2).filter((arg) => arg !== '--');
    const dry = args.includes('pdf-only');
    const target = args.find((arg) => arg !== 'pdf-only');
    if (!target) {
        console.error('Usage: npm run print-label -- <pdf-path-or-order-number> [pdf-only]');
        process.exit(1);
    }
    const isFile = fs.existsSync(target) || target.toLowerCase().endsWith('.pdf');
    let tracking = null;
    let orderNumber = null;
    let file = null;
    if (isFile) file = path.resolve(target);
    else {
        orderNumber = target;
        tracking = await trackingForOrder(orderNumber);
    }
    const result = await printShippingLabel({ file, tracking, orderNumber, dry, force: Boolean(file) });
    if (result.reason) console.log(result.reason);
    if (result.printed) console.log(`Printed shipping label on "${result.printer}" (${path.basename(result.source)})`);
    if (!result.printed && !dry) process.exit(result.pdf ? 0 : 1);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
    main().catch((err) => {
        console.error(err.message || err);
        process.exit(1);
    });
}

