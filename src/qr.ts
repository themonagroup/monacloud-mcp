// QR nạp ví hiện được ngay trong terminal (Claude Code / Codex / Gemini CLI).
// Các CLI không vẽ ảnh PNG từ tool result, nên MCP tự dựng chuỗi VietQR EMVCo (NAPAS)
// rồi in QR bằng ký tự khối; kèm file PNG + link ảnh để người dùng chọn cách quét.
import QRCode from 'qrcode';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type JsonObject = Record<string, unknown>;

// Mã ngân hàng (như img.vietqr.io dùng) → BIN NAPAS. Bổ sung khi MONA nhận tiền ở ngân hàng khác.
export const BANK_BIN: Record<string, string> = {
  ACB: '970416',
  VCB: '970436', VIETCOMBANK: '970436',
  TCB: '970407', TECHCOMBANK: '970407',
  MB: '970422', MBB: '970422', MBBANK: '970422',
  BIDV: '970418',
  VPB: '970432', VPBANK: '970432',
  TPB: '970423', TPBANK: '970423',
  VIB: '970441',
  STB: '970403', SACOMBANK: '970403',
  CTG: '970415', ICB: '970415', VIETINBANK: '970415',
  VBA: '970405', AGRIBANK: '970405',
  MSB: '970426',
  SHB: '970443',
  HDB: '970437', HDBANK: '970437',
  OCB: '970448',
  EIB: '970431', EXIMBANK: '970431',
  LPB: '970449', LPBANK: '970449',
  SEAB: '970440', SEABANK: '970440',
  NAB: '970428', NAMABANK: '970428',
  BAB: '970409', BACABANK: '970409',
  NCB: '970419',
  ABB: '970425', ABBANK: '970425',
  PVCB: '970412', PVCOMBANK: '970412',
  VAB: '970427', VIETABANK: '970427',
  KLB: '970452', KIENLONGBANK: '970452',
  PGB: '970430', PGBANK: '970430',
  BVB: '970438', BAOVIETBANK: '970438',
  VCCB: '970454', BVBANK: '970454',
  CAKE: '546034',
  TIMO: '963388',
};

const tlv = (id: string, value: string): string => `${id}${String(value.length).padStart(2, '0')}${value}`;

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) theo chuẩn EMVCo, trả 4 ký tự hex hoa. */
export function crc16(input: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(input, 'utf8')) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Nội dung chuyển khoản: bỏ dấu tiếng Việt, chỉ giữ chữ/số/khoảng trắng, tối đa 50 ký tự.
 * Giống cách img.vietqr.io chuẩn hoá (VIBECLOUD-123 → VIBECLOUD123) để khớp regex báo có /VIBECLOUD\d+/ ở app-api.
 */
export function transferContent(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 50);
}

export type VietQrParts = {
  bin: string;
  account: string;
  amount?: number;
  addInfo?: string;
};

/** Chuỗi VietQR EMVCo (NAPAS, dịch vụ QRIBFTTA = chuyển tới số tài khoản), có CRC16. */
export function buildVietQrPayload(parts: VietQrParts): string {
  if (!/^\d{6}$/.test(parts.bin)) throw new Error(`BIN ngân hàng không hợp lệ: ${parts.bin}`);
  if (!/^[A-Za-z0-9]{1,19}$/.test(parts.account)) throw new Error(`Số tài khoản không hợp lệ: ${parts.account}`);
  const amount = parts.amount !== undefined ? Math.round(parts.amount) : undefined;
  const merchant = tlv('00', 'A000000727') + tlv('01', tlv('00', parts.bin) + tlv('01', parts.account)) + tlv('02', 'QRIBFTTA');
  let payload = tlv('00', '01') + tlv('01', amount ? '12' : '11') + tlv('38', merchant) + tlv('53', '704');
  if (amount && amount > 0) payload += tlv('54', String(amount));
  payload += tlv('58', 'VN');
  const content = parts.addInfo ? transferContent(parts.addInfo) : '';
  if (content) payload += tlv('62', tlv('08', content));
  payload += '6304';
  return payload + crc16(payload);
}

export type VietQrImage = {
  bankCode: string;
  bin?: string;
  account: string;
  amount?: number;
  addInfo?: string;
  accountName?: string;
};

/** Đọc link ảnh img.vietqr.io/image/<BANK|BIN>-<account>-<template>.png?amount=&addInfo=&accountName= */
export function parseVietQrImageUrl(value: string | undefined): VietQrImage | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const match = /\/image\/([A-Za-z0-9]+)-([A-Za-z0-9]+)-[A-Za-z0-9_]+\.(?:png|jpe?g)$/i.exec(url.pathname);
  if (!match) return undefined;
  const bankCode = match[1].toUpperCase();
  const bin = /^\d{6}$/.test(bankCode) ? bankCode : BANK_BIN[bankCode];
  const amountRaw = url.searchParams.get('amount');
  const amount = amountRaw && /^\d+$/.test(amountRaw) ? Number(amountRaw) : undefined;
  return {
    bankCode,
    ...(bin ? { bin } : {}),
    account: match[2],
    ...(amount !== undefined ? { amount } : {}),
    ...(url.searchParams.get('addInfo') ? { addInfo: url.searchParams.get('addInfo') as string } : {}),
    ...(url.searchParams.get('accountName') ? { accountName: url.searchParams.get('accountName') as string } : {}),
  };
}

/**
 * QR bằng ký tự khối đầy '██' (1 module = 2 cột × 1 dòng, vùng lặng 2 module), in thẳng trong terminal.
 * Chỉ dùng U+2588 nên mọi font monospace vẽ kín ô, không hở nét như nửa khối.
 * darkTerminal=true (mặc định: nền tối, chữ sáng) vẽ module SÁNG bằng khối → QR đúng cực (đen trên trắng).
 * darkTerminal=false (nền sáng, chữ đen) vẽ module TỐI bằng khối.
 */
export function renderQrAscii(payload: string, darkTerminal = true): string {
  const code = QRCode.create(payload, { errorCorrectionLevel: 'M' });
  const size = code.modules.size;
  const data = code.modules.data;
  const quiet = 2;
  const block = '██';
  const blank = '  ';
  const fill = (dark: boolean): string => (dark === darkTerminal ? blank : block);
  const width = size + quiet * 2;
  const edge = fill(false).repeat(width);
  const lines: string[] = [];
  for (let i = 0; i < quiet; i += 1) lines.push(edge);
  for (let row = 0; row < size; row += 1) {
    let line = fill(false).repeat(quiet);
    for (let col = 0; col < size; col += 1) line += fill(Boolean(data[row * size + col]));
    lines.push(line + fill(false).repeat(quiet));
  }
  for (let i = 0; i < quiet; i += 1) lines.push(edge);
  return lines.join('\n');
}

/** Bản nửa khối (▀▄█) gọn hơn, 2 hàng module / 1 dòng; tuỳ font terminal có thể hở nét. */
export function renderQrAsciiSmall(payload: string): Promise<string> {
  // qrcode 1.5.x: renderer utf8 lỗi 'Invalid array length' khi truyền margin → dùng mặc định.
  return QRCode.toString(payload, { type: 'utf8' });
}

export function renderQrPng(payload: string): Promise<Buffer> {
  return QRCode.toBuffer(payload, { type: 'png', errorCorrectionLevel: 'M', margin: 2, scale: 8 });
}

export function dataUrlToBuffer(value: unknown): Buffer | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^data:image\/(?:png|jpe?g);base64,([A-Za-z0-9+/=\s]+)$/i.exec(value);
  if (!match) return undefined;
  const buffer = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
  return buffer.length ? buffer : undefined;
}

export async function saveQrFile(dir: string, name: string, buffer: Buffer): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, name);
  await writeFile(file, buffer, { mode: 0o600 });
  return file;
}

const safeName = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'topup';

/**
 * Chuẩn hoá kết quả nạp ví để AI đưa cho người dùng: bỏ base64 khỏi text (tốn 15–25k token, CLI không vẽ),
 * thêm qr_ascii (terminal nền tối) / qr_ascii_light (nền sáng) / qr_ascii_small (nửa khối), qr_file (PNG trên máy
 * người dùng), giữ qr_url (ảnh VietQR) và các trường tiền/nội dung.
 */
export async function presentTopup(topup: JsonObject, qrDir: string): Promise<JsonObject> {
  const { qr_data_url: qrDataUrl, ...rest } = topup;
  const orderRef = typeof rest.order_ref === 'string' ? rest.order_ref : typeof rest.topup_id === 'string' ? rest.topup_id : 'topup';
  const image = parseVietQrImageUrl(typeof rest.qr_url === 'string' ? rest.qr_url : undefined);
  const amount = typeof rest.amount_vnd === 'number' ? rest.amount_vnd : image?.amount;
  const result: JsonObject = {
    ...rest,
    ...(amount !== undefined ? { amount_vnd: amount } : {}),
  };
  let payload: string | undefined;
  if (image?.bin) {
    try {
      payload = buildVietQrPayload({ bin: image.bin, account: image.account, amount, addInfo: image.addInfo ?? orderRef });
      result.bank = image.bankCode;
      result.bank_bin = image.bin;
      result.bank_account = image.account;
      if (image.accountName) result.bank_account_name = image.accountName;
      result.transfer_content = transferContent(image.addInfo ?? orderRef);
      result.qr_payload = payload;
      result.qr_ascii = renderQrAscii(payload, true);
      result.qr_ascii_light = renderQrAscii(payload, false);
      result.qr_ascii_small = await renderQrAsciiSmall(payload);
    } catch (error) {
      result.qr_ascii_error = error instanceof Error ? error.message : String(error);
    }
  }
  const png = dataUrlToBuffer(qrDataUrl) ?? (payload ? await renderQrPng(payload) : undefined);
  if (png) {
    try {
      result.qr_file = await saveQrFile(qrDir, `topup-${safeName(orderRef)}.png`, png);
    } catch (error) {
      result.qr_file_error = error instanceof Error ? error.message : String(error);
    }
  }
  return result;
}
