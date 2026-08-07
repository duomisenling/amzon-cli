// listing images —— 商品图片列取与下载
// 全部 mock,不发真实请求;下载走全局 fetch(未配代理时 amazonFetch 等同于它)。

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('imageFileName:扩展名取自 URL,只认常规图片后缀', () => {
  assert.equal(imageFileName('B0TESTASIN', 'MAIN', 'https://img/a/b.png'), 'B0TESTASIN_MAIN.png');
  assert.equal(imageFileName('B0TESTASIN', 'PT01', 'https://img/x.jpg?v=1'), 'B0TESTASIN_PT01.jpg');
  // 奇怪后缀/解析失败回退 .jpg
  assert.equal(imageFileName('B0TESTASIN', 'MAIN', 'https://img/x.weird'), 'B0TESTASIN_MAIN.jpg');
  assert.equal(imageFileName('B0TESTASIN', undefined, '::坏地址::'), 'B0TESTASIN_UNKNOWN.jpg');
});

test('不给 --out-dir 时只返回 URL 列表,不发下载请求', async () => {
  let downloads = 0;
  globalThis.fetch = async () => {
    downloads += 1;
    throw new Error('不该发下载请求');
  };
  const ctx = {
    flags: { marketplace: 'US', asins: 'b0testasin' }, // 小写入口,应归一为大写
    progress() {},
    client: {
      async get(path) {
        assert.match(path, /items\/B0TESTASIN$/, '小写 ASIN 应已归一为大写');
        return {
          images: [
            {
              images: [
                { variant: 'MAIN', link: 'https://img/main.jpg', height: 1000, width: 1000 },
                { variant: 'MAIN', link: 'https://img/main-s.jpg', height: 75, width: 75 },
              ],
            },
          ],
        };
      },
    },
  };
  const result = await listingImages.execute(ctx);
  assert.equal(downloads, 0);
  assert.equal(result.items[0].found, true);
  assert.equal(result.items[0].variantCount, 1);
  assert.equal(result.items[0].images[0].link, 'https://img/main.jpg');
  assert.equal('saved' in result.items[0], false);
});

test('给 --out-dir 时下载每个变体的最大图并落盘,文件名 ASIN_变体.扩展名', async () => {
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
          images: [
            {
              images: [
                { variant: 'MAIN', link: 'https://img.example/main-big.jpg', height: 1500, width: 1500 },
                { variant: 'MAIN', link: 'https://img.example/main-small.jpg', height: 75, width: 75 },
                { variant: 'PT01', link: 'https://img.example/pt01.png', height: 500, width: 500 },
              ],
            },
          ],
        };
      },
    },
  };
  const result = await listingImages.execute(ctx);
  // 只下载最大图:small 不该被请求
  assert.deepEqual(fetched, ['https://img.example/main-big.jpg', 'https://img.example/pt01.png']);
  assert.equal(result.savedTotal, 2);
  const mainFile = join(dir, 'B0TESTASIN_MAIN.jpg');
  assert.equal(existsSync(mainFile), true);
  assert.match(readFileSync(mainFile, 'utf8'), /fake-image-of/);
  assert.equal(existsSync(join(dir, 'B0TESTASIN_PT01.png')), true);
});

test('单个 ASIN 查询失败不拖垮整批,如实记录 found:false', async () => {
  const ctx = {
    flags: { marketplace: 'US', asins: 'B0AAAAAAAA,B0BBBBBBBB' },
    progress() {},
    client: {
      async get(path) {
        if (path.includes('B0AAAAAAAA')) throw new Error('404-ish failure');
        return { images: [{ images: [{ variant: 'MAIN', link: 'https://img/m.jpg', height: 1, width: 1 }] }] };
      },
    },
  };
  const result = await listingImages.execute(ctx);
  assert.equal(result.items[0].found, false);
  assert.match(String(result.items[0].error), /404-ish/);
  assert.equal(result.items[1].found, true);
});

test('--asins 超过 20 个在本地校验被拒', () => {
  const asins = Array.from({ length: 21 }, (_, i) => `B0${String(i).padStart(8, '0')}`).join(',');
  assert.throws(
    () => listingImages.validate({ asins, marketplace: 'US' }),
    (error) => error?.subtype === 'listing.images_asins_invalid',
  );
});
