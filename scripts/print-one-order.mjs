import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

// Print one packing slip for an order already stored in ebay_sales.
// Does not wait for an eBay webhook, and ignores printed_at, so it can
// reprint an old order on the local printer.
//
//   npm run print-order -- 14-15198-21993
//   npm run print-order -- 14-15198-21993 print
//
// With no extra word, this only writes the PDF. Add the word "print"
// to send that one order to the printer in .env.local.
// Reads NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_KEY, PRINTER_NAME,
// SUMATRA_PATH, STORE_NAME, and STORE_URL from .env.local.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.env.PRINT_SLIP_LOADER !== '1') {
    const child = spawn(
        process.execPath,
        ['--conditions=react-server', '--import', 'tsx', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
        {
            cwd: repoRoot,
            stdio: 'inherit',
            env: { ...process.env, PRINT_SLIP_LOADER: '1' },
        }
    );
    child.on('exit', (code) => process.exit(code ?? 1));
} else {
    process.chdir(repoRoot);
    await main();
}

function loadEnvLocal() {
    const envPath = path.join(repoRoot, '.env.local');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m && !process.env[m[1]]) {
            process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
        }
    }
}

function num(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function printPdf(sumatraPath, printerName, filePath) {
    return new Promise((resolve, reject) => {
        if (process.platform === 'win32') {
            execFile(
                sumatraPath,
                ['-print-to', printerName, '-print-settings', 'noscale,landscape,paper=letter', '-silent', '-exit-when-done', filePath],
                { timeout: 60000 },
                (err, _stdout, stderr) => {
                    if (err) reject(new Error(stderr || err.message));
                    else resolve();
                }
            );
        } else {
            execFile(
                'lp',
                ['-d', printerName, '-o', 'media=Custom.8.5x5in', '-o', 'fit-to-page', '-o', 'InputSlot=Rear', '-o', 'orientation-requested=3', filePath],
                { timeout: 60000 },
                (err, _stdout, stderr) => {
                    if (err) reject(new Error(stderr || err.message));
                    else resolve();
                }
            );
        }
    });
}

async function main() {
    loadEnvLocal();
    const args = process.argv.slice(2);
    const shouldPrint = args.includes('print');
    const slipOnly = args.includes('slip');
    const orderNumber = args.find((arg) => arg !== 'print' && arg !== 'slip' && !arg.startsWith('--'));
    if (!orderNumber) {
        console.error('Usage: npm run print-order -- <order-number> [print]');
        console.error('Writes the PDF. Add the word print to send that one order to the printer in .env.local.');
        process.exit(1);
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    const printerName = process.env.PRINTER_NAME;
    const sumatraPath = process.env.SUMATRA_PATH;
    
    const requiredEnvVars = {
        NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
        SUPABASE_SERVICE_KEY: supabaseKey,
        PRINTER_NAME: printerName,
    };
    if (process.platform === 'win32') {
        requiredEnvVars.SUMATRA_PATH = sumatraPath;
    }

    for (const [name, value] of Object.entries(requiredEnvVars)) {
        if (!value) {
            console.error(`Missing ${name} in .env.local`);
            process.exit(1);
        }
    }
    if (process.platform === 'win32' && shouldPrint && !fs.existsSync(sumatraPath)) {
        console.error(`SumatraPDF not found at ${sumatraPath}`);
        process.exit(1);
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data: rows, error } = await supabase.from('ebay_sales').select('*').eq('order_number', orderNumber);
    if (error) {
        console.error(error.message);
        process.exit(1);
    }
    if (!rows || rows.length === 0) {
        console.error(`No sales found for order ${orderNumber}`);
        process.exit(1);
    }

    const first = rows[0];
    const { generatePackingSlipPdf } = await import('../app/lib/packing-slip.ts');
    const pdfBytes = await generatePackingSlipPdf({
        orderNumber: first.order_number,
        salesRecordNumber: first.sales_record_number,
        saleDate: first.sale_date,
        buyer: first.buyer,
        shipTo: {
            name: first.ship_to_name,
            street1: first.ship_to_street1,
            street2: first.ship_to_street2,
            city: first.ship_to_city,
            state: first.ship_to_state,
            zip: first.ship_to_zip,
            country: first.ship_to_country,
        },
        shippingService: first.shipping_service,
        subtotal: num(first.order_subtotal),
        shippingCost: num(first.order_shipping_cost),
        tax: num(first.order_tax),
        total: num(first.order_total),
        items: rows.map((row) => ({
            title: row.item_title,
            sku: row.sku,
            ebayItemId: row.ebay_item_id,
            quantity: num(row.quantity_sold) ?? 1,
            soldFor: num(row.sold_for) ?? 0,
            pictureUrl: row.picture_url,
        })),
        storeName: process.env.STORE_NAME?.trim() || 'Packing Slip',
        storeUrl: process.env.STORE_URL?.trim() || null,
    });

    const safeName = orderNumber.replace(/[^a-z0-9-]/gi, '_');
    const pdfPath = path.join(os.tmpdir(), `packing-slip-${safeName}-${process.pid}.pdf`);
    fs.writeFileSync(pdfPath, Buffer.from(pdfBytes));
    console.log(
        `Order ${orderNumber}: ${rows.length} item(s), ship-to ${first.ship_to_name ? 'present' : 'missing'}, ${pdfBytes.length} bytes`
    );

    if (!shouldPrint) {
        console.log(`PDF only. Not sent to the printer. Written to ${pdfPath}`);
        return;
    }

    console.log(`Printing order ${orderNumber} on "${printerName}"...`);
    await printPdf(sumatraPath, printerName, pdfPath);

    const storagePath = `${orderNumber}.pdf`;
    const { error: uploadErr } = await supabase.storage
        .from('packing-slips')
        .upload(storagePath, fs.readFileSync(pdfPath), { contentType: 'application/pdf', upsert: true });
    if (uploadErr) {
        console.error(`Printed, but saving the slip failed: ${uploadErr.message}`);
    } else {
        const { data: publicUrlData } = supabase.storage.from('packing-slips').getPublicUrl(storagePath);
        await supabase
            .from('ebay_sales')
            .update({
                packing_slip_url: publicUrlData.publicUrl,
                packing_slip_generated_at: new Date().toISOString(),
                printed_at: new Date().toISOString(),
            })
            .eq('order_number', orderNumber);
    }

    fs.unlinkSync(pdfPath);
    console.log(`Printed packing slip for ${orderNumber} on "${printerName}"`);

    if (!slipOnly) {
        const { printShippingLabel } = await import('./label-print.mjs');
        const label = await printShippingLabel({
            tracking: first.tracking_number,
            orderNumber,
        });
        if (label.printed) console.log(`Printed shipping label on "${label.printer}"`);
        else console.log(label.reason);
    }
}
