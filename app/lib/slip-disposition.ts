export function slipContentDisposition(orderNumber: string, download: boolean): string {
  const safe = orderNumber.replace(/[^A-Za-z0-9_-]/g, '');
  const type = download ? 'attachment' : 'inline';
  return `${type}; filename="packing-slip-${safe}.pdf"`;
}
