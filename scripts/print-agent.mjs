import fs from 'fs';
import os from 'os';
import net from 'net';
import http from 'http';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { orderNumberForLabel, scanNewLabels } from './label-print.mjs';

// -----------------------------------------------------------------------
// Local packing-slip print agent.
//
// Runs on a machine that can see both Supabase (internet) and the printer
// (local network/WiFi) — the two things Vercel's serverless webhook can't
// reach at once. Listens on Supabase Realtime for ebay_sales rows that get
// a packing_slip_url set (i.e. the webhook just generated a slip) and sends
// the PDF straight to the printer via SumatraPDF's silent CLI printing.
// Also does a one-time catch-up scan on startup for anything generated
// while this script wasn't running.
//
// Required env vars (reads from .env.local in the repo root):
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//   PRINTER_NAME   — exact Windows printer name (Settings > Printers & Scanners)
//   SUMATRA_PATH   — path to SumatraPDF.exe (https://www.sumatrapdfreader.org,
//                    portable build, no install needed)
//
// Run with: node scripts/print-agent.mjs   (leave the window open, or wire
// it to Task Scheduler "at log on" with "restart on failure" to survive
// reboots).
// -----------------------------------------------------------------------

function loadEnvLocal() {
  const envPath = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim().replace(/^'|'$/g, '');
    }
  }
}
loadEnvLocal();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PRINTER_NAME = process.env.PRINTER_NAME;
const SUMATRA_PATH = process.env.SUMATRA_PATH;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

async function discordNotify(message) {
  console.log(`[discord] Attempting to notify: ${message}`);
  console.log(`[discord] URL is ${DISCORD_WEBHOOK_URL ? 'set' : 'NOT SET'}`);
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message })
    });
    console.log(`[discord] Sent, status: ${res.status}`);
  } catch (err) {
    console.error('[discord]', err.message);
  }
}

const requiredEnvVars = { SUPABASE_URL, SUPABASE_KEY, PRINTER_NAME };
if (process.platform === 'win32') {
  requiredEnvVars.SUMATRA_PATH = SUMATRA_PATH;
}

for (const [name, val] of Object.entries(requiredEnvVars)) {
  if (!val) {
    console.error(`[print-agent] Missing required env var: ${name} (set it in .env.local)`);
    process.exit(1);
  }
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const lock = net.createServer();
await new Promise((resolve, reject) => {
  lock.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('[print-agent] another print agent is already running');
      process.exit(0);
    }
    reject(err);
  });
  lock.listen(47621, '127.0.0.1', resolve);
});

// In-flight guard so a burst of realtime events for the same order (one per
// line item) doesn't try to print it twice concurrently before the DB claim
// (printed_at) round-trips.
const printing = new Set();

async function claimOrder(orderNumber) {
  const { data, error } = await supabase
    .from('ebay_sales')
    .update({ printed_at: new Date().toISOString() })
    .eq('order_number', orderNumber)
    .is('printed_at', null)
    .not('packing_slip_url', 'is', null)
    .select('id, packing_slip_url');
  if (error) {
    console.error(`[print-agent] claim failed for ${orderNumber}:`, error.message);
    return null;
  }
  if (!data || data.length === 0) return null; // already claimed/printed elsewhere
  return data[0].packing_slip_url;
}

function printPdf(filePath) {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      execFile(
        SUMATRA_PATH,
        ['-print-to', PRINTER_NAME, '-print-settings', 'noscale,landscape,paper=letter', '-silent', '-exit-when-done', filePath],
        (err, stdout, stderr) => {
          if (err) reject(new Error(stderr || err.message));
          else resolve();
        }
      );
    } else {
      execFile(
        'lp',
        ['-d', PRINTER_NAME, '-o', 'media=Letter', '-o', 'fit-to-page', '-o', 'InputSlot=Rear', '-o', 'orientation-requested=3', filePath],
        (err, stdout, stderr) => {
          if (err) reject(new Error(stderr || err.message));
          else resolve();
        }
      );
    }
  });
}

async function printOrder(orderNumber) {
  if (printing.has(orderNumber)) return;
  printing.add(orderNumber);
  try {
    const slipUrl = await claimOrder(orderNumber);
    if (!slipUrl) return; // nothing to do — already printed or no slip yet

    console.log(`[print-agent] printing order ${orderNumber}...`);
    const res = await fetch(slipUrl);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());

    const tempFile = path.join(os.tmpdir(), `packing-slip-${orderNumber.replace(/[^a-z0-9-]/gi, '_')}.pdf`);
    fs.writeFileSync(tempFile, bytes);

    await printPdf(tempFile);
    fs.unlinkSync(tempFile);

    console.log(`[print-agent] printed order ${orderNumber}`);
    await discordNotify(`🖨️ Packing slip printed for order ${orderNumber}`);
  } catch (err) {
    console.error(`[print-agent] failed to print order ${orderNumber}:`, err.message || err);
    // Roll back the claim so it gets retried (next realtime event, or next startup catch-up).
    await supabase.from('ebay_sales').update({ printed_at: null }).eq('order_number', orderNumber);
  } finally {
    printing.delete(orderNumber);
  }
}

async function catchUpPending() {
  const { data, error } = await supabase
    .from('ebay_sales')
    .select('order_number')
    .not('packing_slip_url', 'is', null)
    .is('printed_at', null);
  if (error) {
    console.error('[print-agent] catch-up query failed:', error.message);
    return;
  }
  const orders = [...new Set((data ?? []).map((r) => r.order_number))];
  if (orders.length > 0) {
    console.log(`[print-agent] catch-up: ${orders.length} pending slip(s)`);
  }
  for (const orderNumber of orders) {
    await printOrder(orderNumber);
  }
}

function subscribe() {
  const channel = supabase
    .channel('packing-slip-print')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'ebay_sales' },
      (payload) => {
        const row = payload.new;
        if (row.packing_slip_url && !row.printed_at) {
          printOrder(row.order_number);
        }
      }
    )
    .subscribe((status) => {
      console.log(`[print-agent] realtime status: ${status}`);
    });
  return channel;
}

async function printSlipFromSite(orderNumber) {
  // Try to use the already-generated PDF from the cloud to ensure re-prints are identical
  const { data, error } = await supabase
    .from('ebay_sales')
    .select('packing_slip_url')
    .eq('order_number', orderNumber)
    .not('packing_slip_url', 'is', null)
    .limit(1);

  if (!error && data && data.length > 0 && data[0].packing_slip_url) {
    console.log(`[print-agent] reprinting existing slip for ${orderNumber}...`);
    try {
      const res = await fetch(data[0].packing_slip_url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const tempFile = path.join(os.tmpdir(), `packing-slip-${orderNumber.replace(/[^a-z0-9-]/gi, '_')}.pdf`);
      fs.writeFileSync(tempFile, bytes);
      await printPdf(tempFile);
      fs.unlinkSync(tempFile);
      console.log(`[print-agent] reprinted downloaded slip for ${orderNumber}`);
      await discordNotify(`🖨️ Packing slip reprinted for order ${orderNumber}`);
      return;
    } catch (err) {
      console.error(`[print-agent] failed to download existing slip for ${orderNumber}, falling back to local generation:`, err.message);
    }
  }

  const script = fileURLToPath(new URL('./print-one-order.mjs', import.meta.url));
  return new Promise((resolve, reject) => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const child = spawn(process.execPath, [script, orderNumber, 'print', 'slip'], {
      cwd: repoRoot,
      env: process.env,
    });
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.stdout.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        discordNotify(`🖨️ Packing slip generated and printed for order ${orderNumber}`);
        resolve();
      }
      else reject(new Error(err.trim() || `print exited ${code}`));
    });
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const slipSite = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname !== '/print-slip') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const orderNumber = url.searchParams.get('order')?.trim();
    if (!orderNumber) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing order');
      return;
    }
    await printSlipFromSite(orderNumber);
    const safe = escapeHtml(orderNumber);
    const printer = escapeHtml(PRINTER_NAME);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>Printed</title><p>Packing slip ${safe} was sent to ${printer}. Portrait 5x8.5.</p>`);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(err.message || String(err));
  }
});
slipSite.on('error', (err) => {
  console.error('[print-agent] slip link:', err.message);
});
slipSite.listen(47622, '127.0.0.1', () => {
  console.log('[print-agent] website print-slip link → http://127.0.0.1:47622/print-slip');
});

console.log(`[print-agent] starting — packing slips on "${PRINTER_NAME}", shipping labels on "${process.env.LABEL_PRINTER_NAME || 'Y41BT Label'}"`);
await catchUpPending();
subscribe();
async function printedRecently(orderNumber) {
  const { data, error } = await supabase
    .from('ebay_sales')
    .select('printed_at')
    .eq('order_number', orderNumber)
    .not('printed_at', 'is', null)
    .limit(1);
  if (error || !data?.length || !data[0].printed_at) return false;
  return Date.now() - new Date(data[0].printed_at).getTime() < 10 * 60 * 1000;
}

// The ship webhook prints a slip as soon as the slip URL is saved. The label
// watcher used to print that same slip again. One order keeps the in-flight
// slot until the first print finishes.
async function printSlipOnce(orderNumber) {
  if (printing.has(orderNumber)) return;
  printing.add(orderNumber);
  try {
    if (await printedRecently(orderNumber)) {
      console.log(`[print-agent] packing slip for ${orderNumber} already sent`);
      return;
    }
    await printSlipFromSite(orderNumber);
    console.log(`[print-agent] packing slip for ${orderNumber} sent with the shipping label`);
  } finally {
    printing.delete(orderNumber);
  }
}

async function printSlipsForNewLabels() {
  const files = await scanNewLabels();
  for (const filePath of files) {
    let orderNumber = null;
    try {
      orderNumber = await orderNumberForLabel(filePath);
    } catch (err) {
      console.error('[label] order lookup:', err.message || err);
      continue;
    }
    if (!orderNumber) {
      console.log(`[label] ${path.basename(filePath)} printed; no matching sale, packing slip not sent`);
      continue;
    }
    try {
      await printSlipOnce(orderNumber);
    } catch (err) {
      console.error(`[print-agent] packing slip for ${orderNumber}: ${err.message || err}`);
    }
  }
}

await printSlipsForNewLabels();
let slipQueueBusy = false;
async function printQueuedSlips() {
  if (slipQueueBusy) return;
  slipQueueBusy = true;
  try {
    const { data, error } = await supabase
      .from('ebay_webhook_events')
      .select('notification_id, order_number')
      .eq('topic', 'PACKING_SLIP_PRINT')
      .order('received_at', { ascending: true })
      .limit(5);
    if (error) {
      console.error('[print-agent] slip queue:', error.message);
      return;
    }
    const seen = new Set();
    for (const row of data ?? []) {
      if (!row.order_number || seen.has(row.order_number)) {
        await supabase.from('ebay_webhook_events').delete().eq('notification_id', row.notification_id);
        continue;
      }
      seen.add(row.order_number);
      try {
        await printSlipFromSite(row.order_number);
        await supabase.from('ebay_webhook_events').delete().eq('notification_id', row.notification_id);
        console.log(`[print-agent] printed queued slip ${row.order_number}`);
      } catch (err) {
        const message = err.message || String(err);
        console.error(`[print-agent] queued slip ${row.order_number}: ${message}`);
        if (/No sales found/.test(message)) {
          await supabase.from('ebay_webhook_events').delete().eq('notification_id', row.notification_id);
        }
      }
    }
  } finally {
    slipQueueBusy = false;
  }
}

let labelQueueBusy = false;
async function printQueuedLabels() {
  if (labelQueueBusy) return;
  labelQueueBusy = true;
  try {
    const { data, error } = await supabase
      .from('ebay_webhook_events')
      .select('notification_id, order_number')
      .eq('topic', 'SHIPPING_LABEL_PRINT')
      .order('received_at', { ascending: true })
      .limit(5);
    if (error) {
      console.error('[print-agent] label queue:', error.message);
      return;
    }
    const seen = new Set();
    for (const row of data ?? []) {
      if (!row.order_number || seen.has(row.order_number)) {
        await supabase.from('ebay_webhook_events').delete().eq('notification_id', row.notification_id);
        continue;
      }
      seen.add(row.order_number);
      try {
        const repoRoot = process.cwd();
        const savedFile = path.join(repoRoot, 'labels', 'saved', `${row.order_number}.pdf`);
        const { printShippingLabel } = await import('./label-print.mjs');
        const fileToPrint = fs.existsSync(savedFile) ? savedFile : null;
        const result = await printShippingLabel({ file: fileToPrint, orderNumber: row.order_number, force: true });
        
        await supabase.from('ebay_webhook_events').delete().eq('notification_id', row.notification_id);
        if (result.printed) {
          console.log(`[print-agent] reprinted queued label ${row.order_number}`);
        } else {
          console.log(`[print-agent] queued label ${row.order_number} failed: ${result.reason}`);
        }
      } catch (err) {
        console.error(`[print-agent] queued label ${row.order_number}: ${err.message || String(err)}`);
      }
    }
  } finally {
    labelQueueBusy = false;
  }
}

await printQueuedSlips();
await printQueuedLabels();
setInterval(() => {
  printSlipsForNewLabels().catch((err) => console.error('[label]', err.message || err));
}, 5000);

setInterval(() => {
  printQueuedSlips().catch((err) => console.error('[print-agent] slip queue:', err.message || err));
  printQueuedLabels().catch((err) => console.error('[print-agent] label queue:', err.message || err));
}, 60000);

function cleanupSavedLabels() {
  try {
    const savedDir = path.join(process.cwd(), 'labels', 'saved');
    if (!fs.existsSync(savedDir)) return;
    const now = Date.now();
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
    for (const file of fs.readdirSync(savedDir)) {
      if (!file.endsWith('.pdf')) continue;
      const p = path.join(savedDir, file);
      try {
        const stats = fs.statSync(p);
        if (now - stats.mtimeMs > maxAge) {
          fs.unlinkSync(p);
          console.log(`[label] cleaned up old saved label ${file}`);
        }
      } catch (err) {}
    }
  } catch (err) {
    console.error('[label] cleanup error:', err.message);
  }
}

setInterval(cleanupSavedLabels, 60 * 60 * 1000);
cleanupSavedLabels();

console.log('[print-agent] listening for new packing slips and shipping labels (Ctrl+C to stop)...');
