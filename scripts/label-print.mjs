import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
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
// into labels\inbox, or into Downloads, and the print agent sends it to the
// label printer. A matching order number is found by the tracking number
// in the file name or in the PDF text.

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
    return path.join(os.homedir(), 'Downloads');
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

function printPdf(filePath) {
    const sumatra = process.env.SUMATRA_PATH;
    const printer = labelPrinterName();
    if (!sumatra || !fs.existsSync(sumatra)) {
        throw new Error(`SumatraPDF not found at ${sumatra || '(SUMATRA_PATH unset)'}`);
    }
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

function listPdfs(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((name) => name.toLowerCase().endsWith('.pdf') && !/packing[-_ ]?slip/i.test(name))
        .map((name) => path.join(dir, name));
}

async function pdfText(filePath) {
    const result = await run('python', [
        '-c',
        'import sys,pypdfium2 as p; d=p.PdfDocument(sys.argv[1]); print("\\n".join((pg.get_textpage().get_text_bounded() or "") for pg in d))',
        filePath,
    ]);
    return result.stdout || '';
}

export async function findLabelPdf({ tracking, orderNumber } = {}) {
    const needles = [tracking, orderNumber].filter(Boolean).map((value) => String(value).replace(/\s+/g, ''));
    const files = [...listPdfs(inboxDir()), ...listPdfs(downloadsDir())].sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
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
            reason: `No shipping-label PDF found for this order. Download it from eBay into ${inboxDir()} or Downloads, then run the command again.`,
        };
    }
    const dest = path.join(os.tmpdir(), `thermal-label-${path.basename(src).replace(/[^a-z0-9.]+/gi, '_')}`);
    const fitted = await fitLabel(src, dest, force || Boolean(file));
    if (!fitted.ok) {
        return { printed: false, reason: fitted.skip ? `${path.basename(src)} is not a carrier shipping label.` : fitted.detail };
    }
    if (dry) {
        return { printed: false, pdf: dest, source: src, reason: `PDF only. Not sent to the label printer. Written to ${dest}` };
    }
    await printPdf(dest);
    try { fs.unlinkSync(dest); } catch { /* temp file */ }
    return { printed: true, source: src, printer: labelPrinterName() };
}

export async function scanNewLabels() {
    loadEnvLocal();
    fs.mkdirSync(inboxDir(), { recursive: true });
    const previous = readState();
    const firstRun = !previous;
    const state = previous || {};
    const files = [...listPdfs(inboxDir()), ...listPdfs(downloadsDir())];
    let printed = 0;
    for (const filePath of files) {
        let mtime = 0;
        try { mtime = fs.statSync(filePath).mtimeMs; } catch { continue; }
        if (state[filePath] === mtime) continue;
        if (firstRun) {
            state[filePath] = mtime;
            continue;
        }
        const result = await printShippingLabel({ file: filePath, force: false });
        if (result.printed) {
            printed += 1;
            console.log(`[label] printed ${path.basename(filePath)} on "${result.printer}"`);
        } else if (result.reason && !/not a carrier/.test(result.reason)) {
            console.error(`[label] ${path.basename(filePath)}: ${result.reason}`);
        }
        state[filePath] = mtime;
    }
    writeState(state);
    if (firstRun) {
        console.log(`[label] watching ${inboxDir()} and Downloads for new shipping labels → "${labelPrinterName()}" (${files.length} already there, left alone)`);
    }
    return printed;
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

