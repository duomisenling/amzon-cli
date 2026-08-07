// listing images —— 商品图片列取与下载
// 全部 mock,不发真实请求;下载走全局 fetch(未配代理时 fetchDocumentBuffer 等同于它)。

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, test } from 'node:test';
import { pickLargestPerVariant, imageFileName, listingImages } from '../dist/shortcuts/listing/images.js';

const originalFetch = globalThis.fetch;
const roots = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function tempDir() {
  const dir = join(tmpdir(), `amz-cli-images-${process.pid}-${Date.now()}-${roots.length}`);
  mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

const catalogItem = (asin, images) => ({ asin, images: [{ images }] });

// ───────────────────────────────── 纯逻辑

test('pickLargestPerVariant:每个变体只留面积最大的一张', () => {
  const picked = pickLargestPerVariant([
    { variant: 'MAIN', link: 'https://img/main-small.jpg', height: 75, width: 75 },
    { variant: 'MAIN', link: 'https://img/main-big.jpg', height: 1500, width: 1500 },
    { variant: 'PT01', link: 'https://img/pt01.jpg', height: 500, width: 500 },
    { link: 'https://img/no-variant.jpg', height: 100, width: 100 }, // 无 variant 归 UNKNOWN
    { variant: 'PT02' }, // 无 link,跳过
  ]);
  assert.deepEqual(picked.map((p) => p.link), [
    'https://img/main-big.jpg',
    'https://img/pt01.jpg',
    'https://img/no-variant.jpg',
  ]);
});

test('pickLargestPerVariant:缺宽高的按疑似原图处理,不会输给带尺寸的缩略图', () => {
  const picked = pickLargestPerVariant([
    { variant: 'MAIN', link: 'https://img/main-thumb.jpg', height: 75, width: 75 },
    { variant: 'MAIN', link: 'https://img/main-original.jpg' }, // 无尺寸 = 疑似原图
  ]);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].link, 'https://img/main-original.jpg', '无尺寸原图输给了缩略图');
});

test('imageFileName:扩展名只认常规图片后缀,ASIN/variant 消毒后拼接', () => {
  assert.equal(imageFileName('B0TESTASIN', 'MAIN', 'https://img/a/b.png'), 'B0TESTASIN_MAIN.png');
  assert.equal(imageFileName('B0TESTASIN', 'PT01', 'https://img/x.jpg?v=1'), 'B0TESTASIN_PT01.jpg');
  assert.equal(imageFileName('B0TESTASIN', 'MAIN', 'https://img/x.weird'), 'B0TESTASIN_MAIN.jpg');
  assert.equal(imageFileName('B0TESTASIN', undefined, '::坏地址::'), 'B0TESTASIN_UNKNOWN.jpg');
});

test('imageFileName:恶意 variant 的路径分隔符与非法字符被剥掉,不能逃逸目录', () => {
  const name = imageFileName('B0TESTASIN', '../..\\evil', 'https://img/x.jpg');
  assert.equal(name.includes('/'), false);
  assert.equal(name.includes('\\'), false);
  assert.equal(name.includes('..'), false, '文件名里残留 .. ');
  // 拼接后仍然落在目标目录内
  const dir = resolve('safe-dir');
  assert.equal(resolve(dir, name).startsWith(dir + sep), true, '拼接结果逃出了目标目录');
  // Windows 非法字符同样被剥
  assert.equal(imageFileName('B0TESTASIN', 'A:B*C?', 'https://img/x.jpg'), 'B0TESTASIN_ABC.jpg');
});

// ───────────────────────────────── 校验与查询

test('validate 与 execute 同口径:去重后不超上限即可通过', () => {
  // 21 个原始项但含大小写重复,去重后 20 个 → 应通过
  const dup = Array.from({ length: 20 }, (_, i) => `B0${String(i).padStart(8, '0')}`);
  const asins = [...dup, dup[0].toLowerCase()].join(',');
  listingImages.validate({ asins, marketplace: 'US' }); // 不抛即通过
  // 真正 21 个不同的才拒绝
  const tooMany = Array.from({ length: 21 }, (_, i) => `B0${String(i).padStart(8, '0')}`).join(',');
  assert.throws(
    () => listingImages.validate({ asins: tooMany, marketplace: 'US' }),
    (error) => error?.subtype === 'listing.images_asins_invalid',
  );
});

test('一次批量调用查全部 ASIN;小写归一;格式非法的不发请求记 found:false', async () => {
  const calls = [];
  const ctx = {
    flags: { marketplace: 'US', asins: 'b0testasin,not-an-asin' },
    progress() {},
    client: {
      async get(path, query) {
        calls.push({ path, query });
        return { items: [catalogItem('B0TESTASIN', [{ variant: 'MAIN', link: 'https://img/m.jpg', height: 1000, width: 1000 }])] };
      },
    },
  };
  const result = await listingImages.execute(ctx);
  // 只发一次批量请求,且只带格式合法的 ASIN
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/catalog/2022-04-01/items');
  assert.equal(calls[0].query.identifiers, 'B0TESTASIN');
  assert.equal(calls[0].query.identifiersType, 'ASIN');

  assert.equal(result.items[0].found, true);
  assert.equal(result.items[1].found, false);
  assert.match(result.items[1].error, /格式非法/);
});

test('批级错误(如授权过期)直接抛出,不吞成 found:false', async () => {
  const authError = Object.assign(new Error('unauthorized'), { subtype: 'sp_api.unauthorized' });
  const ctx = {
    flags: { marketplace: 'US', asins: 'B0TESTASIN' },
    progress() {},
    client: {
      async get() {
        throw authError;
      },
    },
  };
  await assert.rejects(() => listingImages.execute(ctx), (err) => err === authError);
});

test('ASIN 存在但暂无图片:found:true + variantCount 0,与查不到可区分', async () => {
  const ctx = {
    flags: { marketplace: 'US', asins: 'B0AAAAAAAA,B0BBBBBBBB' },
    progress() {},
    client: {
      async get() {
        return { items: [catalogItem('B0AAAAAAAA', [])] }; // B0B 不在响应里
      },
    },
  };
  const result = await listingImages.execute(ctx);
  assert.deepEqual(
    result.items.map((r) => ({ asin: r.asin, found: r.found, variantCount: r.variantCount })),
    [
      { asin: 'B0AAAAAAAA', found: true, variantCount: 0 },
      { asin: 'B0BBBBBBBB', found: false, variantCount: undefined },
    ],
  );
});

// ───────────────────────────────── 下载

test('给 --out-dir 时下载每个变体的最大图并落盘,不下载缩略图', async () => {
  const dir = tempDir();
  const fetched = [];
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return new Response(Buffer.from(`fake-image-of-${url}`), { status: 200 });
  };
  const ctx = {
    flags: { marketplace: 'US', asins: 'B0TESTASIN', outDir: dir },
    progress() {},
    client: {
      async get() {
        return {
          items: [
            catalogItem('B0TESTASIN', [
              { variant: 'MAIN', link: 'https://img.example/main-big.jpg', height: 1500, width: 1500 },
              { variant: 'MAIN', link: 'https://img.example/main-small.jpg', height: 75, width: 75 },
              { variant: 'PT01', link: 'https://img.example/pt01.png', height: 500, width: 500 },
            ]),
          ],
        };
      },
    },
  };
  const result = await listingImages.execute(ctx);
  assert.deepEqual(fetched.sort(), ['https://img.example/main-big.jpg', 'https://img.example/pt01.png']);
  assert.equal(result.savedTotal, 2);
  assert.equal(result.failedTotal, 0);
  const mainFile = join(dir, 'B0TESTASIN_MAIN.jpg');
  assert.equal(existsSync(mainFile), true);
  assert.match(readFileSync(mainFile, 'utf8'), /fake-image-of/);
  assert.equal(existsSync(join(dir, 'B0TESTASIN_PT01.png')), true);
});

test('单张图下载失败只记录该张,其余照常保存,整批不中断', async () => {
  const dir = tempDir();
  globalThis.fetch = async (url) => {
    if (String(url).includes('pt01')) return new Response('nope', { status: 503 });
    return new Response(Buffer.from('img'), { status: 200 });
  };
  const ctx = {
    flags: { marketplace: 'US', asins: 'B0TESTASIN', outDir: dir },
    progress() {},
    client: {
      async get() {
        return {
          items: [
            catalogItem('B0TESTASIN', [
              { variant: 'MAIN', link: 'https://img.example/main.jpg', height: 1000, width: 1000 },
              { variant: 'PT01', link: 'https://img.example/pt01.jpg', height: 500, width: 500 },
            ]),
          ],
        };
      },
    },
  };
  const result = await listingImages.execute(ctx);
  assert.equal(result.savedTotal, 1, '成功的那张应已保存');
  assert.equal(result.failedTotal, 1);
  assert.equal(existsSync(join(dir, 'B0TESTASIN_MAIN.jpg')), true);
  assert.equal(result.items[0].saved.length, 1);
  assert.equal(result.items[0].downloadFailed.length, 1);
  assert.equal(result.items[0].downloadFailed[0].variant, 'PT01');
  assert.ok(Array.isArray(result.hints) && result.hints.length > 0, '应提示部分失败可单独重试');
});

test('不给 --out-dir 时只返回 URL 列表,不发下载请求', async () => {
  let downloads = 0;
  globalThis.fetch = async () => {
    downloads += 1;
    throw new Error('不该发下载请求');
  };
  const ctx = {
    flags: { marketplace: 'US', asins: 'B0TESTASIN' },
    progress() {},
    client: {
      async get() {
        return { items: [catalogItem('B0TESTASIN', [{ variant: 'MAIN', link: 'https://img/m.jpg', height: 1, width: 1 }])] };
      },
    },
  };
  const result = await listingImages.execute(ctx);
  assert.equal(downloads, 0);
  assert.equal(result.items[0].found, true);
  assert.equal('saved' in result.items[0], false);
});
