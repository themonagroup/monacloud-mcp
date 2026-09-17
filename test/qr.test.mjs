import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  crc16,
  buildVietQrPayload,
  parseVietQrImageUrl,
  transferContent,
  presentTopup,
  BANK_BIN,
} from '../dist/qr.js';

test('crc16 khớp mẫu EMVCo của MONA Pay (acb-ipn STATUS-BILLING)', () => {
  const sample = '00020101021238410010A00000072701230006970416010912345678953037045405990005802VN62140810MPAY1042336304';
  assert.equal(crc16(sample), '7C1F');
});

test('payload VietQR đúng cấu trúc NAPAS và CRC tự nhất quán', () => {
  const payload = buildVietQrPayload({ bin: '970416', account: '1900636648', amount: 100000, addInfo: 'VIBECLOUD-964152253' });
  assert.ok(payload.startsWith('000201010212'), 'động (12) khi có số tiền');
  for (const part of ['0010A000000727', '0006970416', '01101900636648', '0208QRIBFTTA', '5303704', '5406100000', '5802VN', '0818VIBECLOUD964152253']) {
    assert.ok(payload.includes(part), part);
  }
  assert.equal(payload.slice(-4), crc16(payload.slice(0, -4)));
  assert.equal(buildVietQrPayload({ bin: '970416', account: '1900636648' }).slice(0, 12), '000201010211');
});

test('nội dung chuyển khoản bỏ dấu, chỉ ASCII, tối đa 50 ký tự', () => {
  assert.equal(transferContent('Nạp ví MONA Cloud VIBECLOUD-1'), 'Nap vi MONA Cloud VIBECLOUD1');
  assert.equal(transferContent('x'.repeat(80)).length, 50);
});

test('đọc link img.vietqr.io ra ngân hàng/tài khoản/số tiền/nội dung', () => {
  const parsed = parseVietQrImageUrl('https://img.vietqr.io/image/ACB-1900636648-compact2.png?amount=10000&addInfo=VIBECLOUD-1&accountName=VIBECLOUD');
  assert.deepEqual(parsed, { bankCode: 'ACB', bin: BANK_BIN.ACB, account: '1900636648', amount: 10000, addInfo: 'VIBECLOUD-1', accountName: 'VIBECLOUD' });
  assert.equal(parseVietQrImageUrl('https://img.vietqr.io/image/970416-1900636648-print.png').bin, '970416');
  assert.equal(parseVietQrImageUrl('not a url'), undefined);
});

test('presentTopup: bỏ base64 khỏi text, thêm qr_ascii, qr_file, thông tin chuyển khoản', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monacloud-qr-'));
  const shown = await presentTopup({
    topup_id: '66f0a1b2c3d4e5f6a7b8c9d0',
    order_ref: 'VIBECLOUD-1',
    amount_vnd: 10000,
    status: 'pending',
    qr_url: 'https://img.vietqr.io/image/ACB-1900636648-compact2.png?amount=10000&addInfo=VIBECLOUD-1&accountName=VIBECLOUD',
    qr_data_url: null,
    wallet: 'local',
  }, dir);
  assert.equal(shown.qr_data_url, undefined);
  assert.match(shown.qr_ascii, /^(██|  )+$/m);
  assert.ok(shown.qr_ascii.split('\n').length > 20);
  assert.equal(shown.bank, 'ACB');
  assert.equal(shown.bank_bin, '970416');
  assert.equal(shown.bank_account, '1900636648');
  assert.equal(shown.transfer_content, 'VIBECLOUD1');
  assert.match(shown.qr_ascii_light, /^(██|  )+$/m);
  assert.equal(shown.qr_ascii.split('\n').length, shown.qr_ascii_light.split('\n').length);
  assert.match(shown.qr_ascii_small, /[▀▄█]/);
  assert.equal(shown.amount_vnd, 10000);
  assert.ok(shown.qr_file.endsWith('topup-VIBECLOUD-1.png'));
  const png = await readFile(shown.qr_file);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
});

test('presentTopup: ví chung chỉ có ảnh base64 → ghi file, không có qr_ascii', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monacloud-qr-'));
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const shown = await presentTopup({ topup_id: 'topup-1', order_ref: 'MC123', qr_data_url: `data:image/png;base64,${png.toString('base64')}`, status: 'pending' }, dir);
  assert.equal(shown.qr_data_url, undefined);
  assert.equal(shown.qr_ascii, undefined);
  assert.ok(shown.qr_file.endsWith('topup-MC123.png'));
});
