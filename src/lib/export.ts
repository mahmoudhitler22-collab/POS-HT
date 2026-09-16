// Export utilities — generates real Excel (.xlsx via SpreadsheetML XML) and PDF (via print) files.
// No external dependencies required.

import { formatEgp } from './money';

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

interface Column {
  header: string;
  key: string;
  isMoney?: boolean;
  isQty?: boolean;
}

export function exportExcel(
  filename: string,
  sheetName: string,
  columns: Column[],
  rows: Record<string, unknown>[]
): void {
  const headers = columns.map(c => escapeXml(c.header)).join('</Data></Cell><Cell><Data ss:Type="String">');
  const headerRow = `<Row><Cell><Data ss:Type="String">${headers}</Data></Cell></Row>`;

  const dataRows = rows.map((row) => {
    const cells = columns.map((col) => {
      const val = row[col.key];
      if (val === null || val === undefined) {
        return '<Cell><Data ss:Type="String"></Data></Cell>';
      }
      if (col.isMoney) {
        const egp = Number(val) / 100;
        return `<Cell><Data ss:Type="Number">${egp}</Data></Cell>`;
      }
      if (col.isQty) {
        return `<Cell><Data ss:Type="Number">${Number(val) || 0}</Data></Cell>`;
      }
      const num = Number(val);
      if (!isNaN(num) && typeof val !== 'string') {
        return `<Cell><Data ss:Type="Number">${num}</Data></Cell>`;
      }
      return `<Cell><Data ss:Type="String">${escapeXml(String(val))}</Data></Cell>`;
    }).join('');
    return `<Row>${cells}</Row>`;
  }).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="${escapeXml(sheetName)}">
  <Table>
   ${headerRow}
   ${dataRows}
  </Table>
 </Worksheet>
</Workbook>`;

  const blob = new Blob([xml], { type: 'application/vnd.ms-excel' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}_${new Date().toISOString().slice(0, 10)}.xls`;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportPDF(
  title: string,
  columns: Column[],
  rows: Record<string, unknown>[]
): void {
  const tableHeaders = columns.map(c => `<th>${escapeHtml(c.header)}</th>`).join('');
  const tableRows = rows.map((row) => {
    const cells = columns.map((col) => {
      const val = row[col.key];
      if (col.isMoney) return `<td class="right">${formatEgp(Number(val) || 0)}</td>`;
      if (col.isQty) return `<td class="right">${Number(val) || 0}</td>`;
      return `<td>${val === null ? '—' : escapeHtml(String(val))}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  @page { margin: 15mm; }
  body { font-family: Arial, sans-serif; font-size: 11px; color: #1e293b; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { font-size: 10px; color: #64748b; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; background: #f1f5f9; padding: 6px 8px; border-bottom: 2px solid #cbd5e1; font-size: 10px; text-transform: uppercase; }
  td { padding: 4px 8px; border-bottom: 1px solid #e2e8f0; }
  .right { text-align: right; }
  .footer { margin-top: 16px; font-size: 9px; color: #94a3b8; }
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">Generated: ${new Date().toLocaleString()}</div>
  <table>
    <thead><tr>${tableHeaders}</tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
  <div class="footer">ELAKRAMMEN POS — Computer-generated report</div>
</body>
</html>`;

  const printWindow = window.open('', '_blank');
  if (!printWindow) return;
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.print();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
