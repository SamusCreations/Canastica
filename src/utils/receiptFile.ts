// Receipts can be a photo, a PDF or an electronic invoice XML

export type ReceiptFileKind = 'image' | 'pdf' | 'xml';

/** Works with data URLs and with signed storage URLs (by file extension). */
export function receiptFileKind(url: string): ReceiptFileKind {
  if (/^data:application\/pdf/i.test(url) || /\.pdf(\?|$)/i.test(url)) return 'pdf';
  if (/^data:(application|text)\/xml/i.test(url) || /\.xml(\?|$)/i.test(url)) return 'xml';
  return 'image';
}
