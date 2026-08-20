import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildPatches,
  byteLength,
  charLength,
  aggregateFindings,
  checkBatch,
  checkDraft,
  containsPhrase,
  extractDrafts,
  renderReport,
  safeFileName,
  summarizeErrors,
} from './check-copy.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-copy.mjs');

/** 一条基线草稿:合规、能过。各用例只改自己关心的字段。 */
function baseDraft(overrides = {}) {
  return {
    sku: 'DEMO-TRAY-01',
    marketplace: 'US',
    productType: 'ROTATING_TRAY',
    brand: 'Demobrand',
    title: 'Demobrand Wheat Straw Serving Tray, 22.5 x 31 cm Rectangular',
    highlights: 'Dishwasher safe · Stackable design · Lightweight for daily meals',
    ...overrides,
  };
}

function codes(result) {
  return result.errors.map((e) => e.code);
}

// ───────────────────────────────── 计数

test('charLength 按码点算,变音符号不被算成两个', () => {
  assert.equal(charLength('Aufbewahrungstasche'), 19);
  assert.equal(charLength('café'), 4);
  assert.equal(charLength('Größe'), 5);
});

test('byteLength 是字节:重音字母占 2 字节', () => {
  assert.equal(byteLength('cafe'), 4);
  assert.equal(byteLength('café'), 5);
  assert.equal(byteLength('Größe'), 7); // ö 和 ß 各占 2 字节:5 字符 → 7 字节
});

test('containsPhrase 只匹配独立词,不误伤子串', () => {
  assert.equal(containsPhrase('Best Serving Tray', 'best'), true);
  assert.equal(containsPhrase('Bestellung fertig', 'best'), false);   // 子串不算
  assert.equal(containsPhrase('Risk-Free Purchase', 'risk free'), true); // 连字符归一
  assert.equal(containsPhrase('100% Cotton', '100%'), true);           // 带符号短语
  assert.equal(containsPhrase('Rated #1 Choice', '#1'), true);
});

// ───────────────────────────────── 字符上限

test('基线草稿通过校验', () => {
  const result = checkDraft(baseDraft());
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('标题超 75 字符报错', () => {
  const result = checkDraft(baseDraft({
    title: `Demobrand ${'Wheat Straw Serving Tray Rectangular Stackable Lightweight '.repeat(2)}`,
  }));
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('E_TOO_LONG'));
});

test('媒体类目标题上限放宽到 200', () => {
  const title = `Demobrand ${'A'.repeat(2)} ${'the story of a long book title here '.repeat(2)}`;
  assert.ok(charLength(title) > 75);
  assert.equal(checkDraft(baseDraft({ title, highlights: null })).ok, false);
  const media = checkDraft(baseDraft({ title, highlights: null, media: true }));
  assert.ok(!codes(media).includes('E_TOO_LONG'));
});

test('亮点超 125 字符报错', () => {
  const result = checkDraft(baseDraft({ highlights: 'Stackable design · '.repeat(10) }));
  assert.ok(codes(result).includes('E_TOO_LONG'));
});

test('低于目标区间只是警告,不拦', () => {
  const result = checkDraft(baseDraft({ title: 'Demobrand Tray', highlights: null }));
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.code === 'W_BELOW_TARGET'));
});

test('德语用更宽的目标下限,英语区间不硬套', () => {
  // 49 字符:落在德语下限 55 之下、英语下限 45 之上,正好区分两套区间
  const german = 'Demobrand Serviertablett aus Weizenstroh, 22,5 cm';
  const asDe = checkDraft(baseDraft({
    marketplace: 'DE', title: german, highlights: null,
  }));
  const asUs = checkDraft(baseDraft({
    marketplace: 'US', title: german, highlights: null,
  }));
  assert.equal(asDe.metrics.language, '德语');
  assert.ok(asDe.warnings.some((w) => w.code === 'W_BELOW_TARGET'));  // 55 起
  assert.ok(!asUs.warnings.some((w) => w.code === 'W_BELOW_TARGET')); // 45 起
});

// ───────────────────────────────── 内容规则

test('禁用特殊字符报错,但品牌名里的不算', () => {
  assert.ok(codes(checkDraft(baseDraft({ title: 'Demobrand Tray! Best Value' })))
    .includes('E_BANNED_CHAR'));
  const brandHasBang = checkDraft(baseDraft({
    brand: 'Yeah!', title: 'Yeah! Wheat Straw Serving Tray 22.5 x 31 cm', highlights: null,
  }));
  assert.ok(!codes(brandHasBang).includes('E_BANNED_CHAR'));
});

test('全大写报错,短缩写和白名单放行', () => {
  assert.ok(codes(checkDraft(baseDraft({ title: 'Demobrand WHEAT Straw Serving Tray' })))
    .includes('E_ALL_CAPS'));
  // USB/LED/BPA 这类 3 字母缩写不报
  assert.ok(!codes(checkDraft(baseDraft({
    title: 'Demobrand USB LED Serving Tray 22.5 cm', highlights: null,
  }))).includes('E_ALL_CAPS'));
  // 长缩写走白名单
  assert.ok(!codes(checkDraft(baseDraft({
    title: 'Demobrand ABSX Serving Tray 22.5 cm', highlights: null, allowCaps: ['ABSX'],
  }))).includes('E_ALL_CAPS'));
});

test('同一个词超过两次报错,冠词介词不计', () => {
  const result = checkDraft(baseDraft({
    title: 'Demobrand Tray Tray Tray Wheat Straw', highlights: null,
  }));
  assert.ok(codes(result).includes('E_WORD_REPEAT'));
  // for / of / the 重复多次不报
  assert.ok(!codes(checkDraft(baseDraft({
    title: 'Demobrand Tray for the Kitchen for the Table of Wheat', highlights: null,
  }))).includes('E_WORD_REPEAT'));
});

test('无条件违禁词报错(含其他语言)', () => {
  assert.ok(codes(checkDraft(baseDraft({ title: 'Demobrand Best Serving Tray' })))
    .includes('E_BANNED_WORD'));
  assert.ok(codes(checkDraft(baseDraft({
    marketplace: 'DE', title: 'Demobrand garantiert beste Serviertablett', highlights: null,
  }))).includes('E_BANNED_WORD'));
  assert.ok(codes(checkDraft(baseDraft({
    title: 'Demobrand Antibacterial Serving Tray', highlights: null,
  }))).includes('E_BANNED_WORD'));
});

test('需凭证的词只警告不拦', () => {
  const result = checkDraft(baseDraft({
    title: 'Demobrand BPA-Free Wheat Straw Tray 22.5 cm', highlights: null,
  }));
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.code === 'W_NEEDS_EVIDENCE'));
});

test('主关键词必须出现在标题里', () => {
  const result = checkDraft(baseDraft({
    mainKeyword: 'garlic press', highlights: null,
  }));
  assert.ok(codes(result).includes('E_MAIN_KEYWORD_MISSING'));
});

test('主关键词落在移动端截断线之后只警告', () => {
  // 主词紧跟品牌 → 不警告
  const early = checkDraft(baseDraft({ mainKeyword: 'Wheat Straw', highlights: null }));
  assert.equal(early.ok, true);
  assert.ok(!early.warnings.some((w) => w.code === 'W_MAIN_KEYWORD_LATE'));

  // 主词被挤到 40 字符之后 → 警告(仍算通过,不拦)
  const late = checkDraft(baseDraft({
    title: 'Demobrand Rectangular Stackable Lightweight Serving Tray',
    mainKeyword: 'Serving Tray',
    highlights: null,
  }));
  assert.equal(late.ok, true);
  assert.ok(late.warnings.some((w) => w.code === 'W_MAIN_KEYWORD_LATE'));
});

test('标题必须以品牌开头', () => {
  const result = checkDraft(baseDraft({
    title: 'Wheat Straw Serving Tray by Demobrand, 22.5 x 31 cm', highlights: null,
  }));
  assert.ok(codes(result).includes('E_BRAND_NOT_FIRST'));
});

test('标题和亮点里出现第三方品牌报错', () => {
  const result = checkDraft(baseDraft({
    title: 'Demobrand Case for Sony Headphones 22 cm',
    highlights: 'Fits JBL models · Hard shell · Lightweight',
    thirdPartyBrands: ['Sony', 'JBL'],
  }));
  const found = codes(result).filter((c) => c === 'E_THIRD_PARTY_BRAND');
  assert.equal(found.length, 2, '标题和亮点应各报一次');
});

// ───────────────────────────────── 跨字段

test('标题与亮点重复实词报错,停用词和品牌不算', () => {
  const result = checkDraft(baseDraft({
    title: 'Demobrand Wheat Straw Serving Tray 22.5 cm',
    highlights: 'Wheat straw build · Dishwasher safe · Stackable',
  }));
  assert.ok(codes(result).includes('E_TITLE_HIGHLIGHT_OVERLAP'));
  // 品牌词在两边出现不算重复(实际也不会),白名单可放行
  const allowed = checkDraft(baseDraft({
    title: 'Demobrand Wheat Straw Serving Tray 22.5 cm',
    highlights: 'Wheat straw build · Dishwasher safe · Stackable',
    allowOverlap: ['wheat', 'straw'],
  }));
  assert.ok(!codes(allowed).includes('E_TITLE_HIGHLIGHT_OVERLAP'));
});

test('标题仍超限时不允许填亮点', () => {
  const result = checkDraft({
    sku: 'X', marketplace: 'US', brand: 'Demobrand',
    title: null,
    currentTitle: `Demobrand ${'Wheat Straw Serving Tray Stackable Lightweight '.repeat(3)}`,
    highlights: 'Dishwasher safe · Stackable design · Lightweight',
  });
  assert.ok(codes(result).includes('E_HIGHLIGHTS_NOT_ELIGIBLE'));
});

test('本次不改标题时用现值判断,现值合规就放行', () => {
  const result = checkDraft({
    sku: 'X', marketplace: 'US', brand: 'Demobrand',
    title: null,
    currentTitle: 'Demobrand Serving Tray 22.5 x 31 cm',
    highlights: 'Wheat straw build · Dishwasher safe · Stackable design',
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

// ───────────────────────────────── 搜索词 / 五点

test('搜索词按字节判上限', () => {
  const result = checkDraft(baseDraft({
    highlights: null,
    searchTerms: 'é'.repeat(130), // 260 字节,但只有 130 字符
  }));
  assert.ok(codes(result).includes('E_TOO_LONG'));
  assert.equal(result.metrics.searchTermsBytes, 260);
});

test('搜索词重复用词与前台已用词只警告', () => {
  const result = checkDraft(baseDraft({
    highlights: null,
    searchTerms: 'tray tray bamboo platter',
  }));
  assert.equal(result.ok, true);
  const warned = result.warnings.map((w) => w.code);
  assert.ok(warned.includes('W_SEARCH_TERMS_DUPLICATE'));
  assert.ok(warned.includes('W_SEARCH_TERMS_REUSED'));
});

test('五点超过 5 条或有空条目报错', () => {
  assert.ok(codes(checkDraft(baseDraft({
    highlights: null, bullets: ['a', 'b', 'c', 'd', 'e', 'f'],
  }))).includes('E_TOO_MANY_BULLETS'));
  assert.ok(codes(checkDraft(baseDraft({
    highlights: null, bullets: ['a', ''],
  }))).includes('E_EMPTY_BULLET'));
});

test('五点超 255 只警告(第三方口径,无一手证据),超 700 才报错', () => {
  const over255 = 'Edelstahl 304 Trinkhalme im Set, '.repeat(9); // ~297 字符
  const warned = checkDraft(baseDraft({ highlights: null, bullets: [over255] }));
  assert.equal(warned.ok, true, '不该因为 255 拦人');
  const w = warned.warnings.find((x) => x.code === 'W_ABOVE_POLICY');
  assert.ok(w);
  assert.equal(w.evidence, 'third-party');

  const over700 = 'Edelstahl 304 Trinkhalme im Set, '.repeat(22); // ~726 字符
  const failed = checkDraft(baseDraft({ highlights: null, bullets: [over700] }));
  assert.ok(codes(failed).includes('E_TOO_LONG'));
  assert.match(failed.errors.find((e) => e.code === 'E_TOO_LONG').message, /700/);
});

test('五点太短报错,偏短只警告', () => {
  assert.ok(codes(checkDraft(baseDraft({ highlights: null, bullets: ['zu kurz'] })))
    .includes('E_TOO_SHORT'));
  const short = checkDraft(baseDraft({
    highlights: null, bullets: ['Edelstahl 304 im 8er Set mit zwei Buersten.'],
  }));
  assert.equal(short.ok, true);
  assert.ok(short.warnings.some((w) => w.code === 'W_BELOW_TARGET'));
});

test('五点里的全大写也报错(Amazon schema 明文禁止)', () => {
  const result = checkDraft(baseDraft({
    highlights: null,
    bullets: ['UMWELTFREUNDLICHE STROHHALME aus Edelstahl 304 fuer den taeglichen Gebrauch.'],
  }));
  assert.ok(codes(result).includes('E_ALL_CAPS'));
  assert.equal(result.errors.find((e) => e.code === 'E_ALL_CAPS').field, 'bullets[0]');
});

test('emoji 在标题/亮点/五点里都报错', () => {
  const inTitle = checkDraft(baseDraft({ title: 'Demobrand 🚴 Serving Tray 22,5 cm' }));
  assert.ok(codes(inTitle).includes('E_EMOJI'));

  const inBullet = checkDraft(baseDraft({
    highlights: null,
    bullets: ['🚴 Cleverer Stauraum fuer jede Fahrt, haelt wichtige Dinge griffbereit.'],
  }));
  assert.ok(codes(inBullet).includes('E_EMOJI'));
  assert.equal(inBullet.errors.find((e) => e.code === 'E_EMOJI').field, 'bullets[0]');
});

test('全角括号和商标符号报错', () => {
  const result = checkDraft(baseDraft({
    highlights: null,
    bullets: ['【Touchscreen】Die TPU-Folie schmiegt sich perfekt an das Smartphone an.'],
  }));
  assert.ok(codes(result).includes('E_BANNED_CHAR'));
  assert.ok(codes(checkDraft(baseDraft({ title: 'Demobrand™ Serving Tray 22,5 cm' })))
    .includes('E_BANNED_CHAR'));
});

test('五点是违禁词重灾区,逐条查', () => {
  const result = checkDraft(baseDraft({
    highlights: null,
    bullets: ['Wheat straw body, dishwasher safe.', 'Best quality guaranteed for life.'],
  }));
  assert.equal(result.ok, false);
  const banned = result.errors.filter((e) => e.code === 'E_BANNED_WORD');
  assert.equal(banned.length, 1);
  assert.equal(banned[0].field, 'bullets[1]');
});

test('五点允许第三方品牌(标题/亮点才禁)', () => {
  const result = checkDraft(baseDraft({
    highlights: null,
    thirdPartyBrands: ['Sony', 'JBL'],
    bullets: ['Fits Sony WH-CH720N and JBL Tune 510BT over-ear models.'],
  }));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('第 1 条五点用虚词开头只警告', () => {
  const weak = checkDraft(baseDraft({
    highlights: null,
    bullets: ['Whether you serve breakfast or snacks, this tray carries plates easily.'],
  }));
  assert.equal(weak.ok, true);
  assert.ok(weak.warnings.some((w) => w.code === 'W_WEAK_BULLET_OPENER'));

  const strong = checkDraft(baseDraft({
    highlights: null,
    bullets: ['Wheat straw body carries plates and mugs from kitchen to table.'],
  }));
  assert.ok(!strong.warnings.some((w) => w.code === 'W_WEAK_BULLET_OPENER'));
});

test('两条五点讲同一件事时警告', () => {
  const result = checkDraft(baseDraft({
    highlights: null,
    bullets: [
      'Wheat straw material keeps the tray light and stackable for storage.',
      'Stackable wheat straw construction stores flat and stays light.',
    ],
  }));
  assert.ok(result.warnings.some((w) => w.code === 'W_BULLET_OVERLAP'));
});

// ───────────────────────────────── 整套完整性

test('--complete:三个字段缺一不可', () => {
  const opts = { requireComplete: true };
  const full = {
    ...baseDraft(),
    bullets: ['Wheat straw body holds plates.', 'Stacks flat in a cupboard.',
      'Rinses clean under the tap.'],
  };
  assert.equal(checkDraft(full, opts).ok, true, JSON.stringify(checkDraft(full, opts).errors));

  for (const missing of [{ title: null }, { highlights: null }, { bullets: ['只有一条'] }]) {
    const result = checkDraft({ ...full, ...missing }, opts);
    assert.ok(codes(result).includes('E_INCOMPLETE_SET'), JSON.stringify(missing));
  }
});

test('--complete:五点 3~4 条只警告,不拦(素材不足优先于凑数)', () => {
  const result = checkDraft({
    ...baseDraft(),
    bullets: ['Wheat straw body holds plates.', 'Stacks flat in a cupboard.',
      'Rinses clean under the tap.'],
  }, { requireComplete: true });
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.code === 'W_BULLETS_NOT_FULL'));
});

test('不带 --complete 时不查完整性(向后兼容)', () => {
  assert.equal(checkDraft(baseDraft({ bullets: null })).ok, true);
});

test('亮点和五点讲同一件事时警告', () => {
  const result = checkDraft(baseDraft({
    highlights: 'Dishwasher safe · Stackable design · Lightweight daily use',
    bullets: ['Stackable dishwasher safe tray, lightweight for daily meals.'],
  }));
  assert.ok(result.warnings.some((w) => w.code === 'W_HIGHLIGHT_BULLET_OVERLAP'));
});

test('商品描述里的现存问题只出警告,不拦本次改动', () => {
  const result = checkDraft(baseDraft({
    currentDescription: 'Dieses Set bietet die perfekte Alternative. BPA-frei und langlebig.',
  }));
  assert.equal(result.ok, true, '描述的问题不该拦住三个字段的改动');
  const issues = result.warnings.filter((w) => w.code === 'W_DESCRIPTION_ISSUE');
  assert.ok(issues.length >= 1);
  assert.equal(issues[0].field, 'currentDescription');
});

test('report 提醒没给商品描述', () => {
  assert.match(renderReport(baseDraft()), /商品描述.*未提供/);
  assert.match(
    renderReport(baseDraft({ currentDescription: 'Ein sauberer Beschreibungstext ohne Probleme.' })),
    /商品描述  [0-9]+ 字符/,
  );
});

test('--audit:存量 emoji 只警告,新写的仍然报错', () => {
  const withEmoji = baseDraft({ title: 'Demobrand 🚴 Serving Tray 22 cm' });

  // 新稿:error
  assert.ok(codes(checkDraft(withEmoji)).includes('E_EMOJI'));

  // 审现状:降为警告,不拦
  const audited = checkDraft(withEmoji, { audit: true });
  assert.ok(!codes(audited).includes('E_EMOJI'), '存量 emoji 不该算错误');
  const w = audited.warnings.find((x) => x.code === 'E_EMOJI');
  assert.ok(w);
  assert.match(w.message, /存量,不因此触发改写/);
});

test('--audit 只降 house-rule,合规类错误照报', () => {
  const tooLong = baseDraft({
    title: `Demobrand ${'Wheat Straw Serving Tray Rectangular Stackable '.repeat(2)}`,
  });
  assert.ok(codes(checkDraft(tooLong, { audit: true })).includes('E_TOO_LONG'));
});

// ───────────────────────────────── 素材提取

const RAW_ITEM = {
  ok: true,
  data: {
    item: {
      sku: 'DEMO-1',
      summaries: [{ asin: 'B0DEMO0001', productType: 'DRINKING_STRAW' }],
      attributes: {
        item_name: [{ value: 'Alter Titel', language_tag: 'de_DE', marketplace_id: 'A1PA' }],
        bullet_point: [
          { value: 'Erste Zeile.', language_tag: 'de_DE', marketplace_id: 'A1PA' },
          { value: 'Zweite Zeile.', language_tag: 'de_DE', marketplace_id: 'A1PA' },
        ],
        product_description: [{ value: 'Beschreibung mit Beschichtung.', language_tag: 'de_DE' }],
        brand: [{ value: 'Demobrand' }],
        color: [{ value: 'Goldfarben' }],
        material: [{ value: 'Edelstahl' }],
        special_feature: [{ value: 'Bruchfest' }],
        child_parent_sku_relationship: [{ parent_sku: 'DEMO-PARENT' }],
      },
    },
  },
};

test('extract 把商品描述和结构化属性一并取出(手写提取漏的正是这些)', () => {
  const { drafts } = extractDrafts([RAW_ITEM], { marketplace: 'DE' });
  const d = drafts[0];
  assert.equal(d.sku, 'DEMO-1');
  assert.equal(d.productType, 'DRINKING_STRAW');
  assert.equal(d.brand, 'Demobrand');
  assert.match(d.currentDescription, /Beschichtung/);
  assert.equal(d.currentBullets.length, 2);
  assert.equal(d.sourceFacts.specialFeature, 'Bruchfest');
  assert.equal(d.sourceFacts.parentSku, 'DEMO-PARENT');
  // 要写的三个字段留空
  assert.equal(d.title, null);
  assert.equal(d.highlights, null);
  assert.equal(d.bullets, null);
});

test('extract 自动生成 valueTemplate(去掉 value 键)', () => {
  const { drafts } = extractDrafts([RAW_ITEM]);
  assert.deepEqual(drafts[0].valueTemplate.item_name,
    { language_tag: 'de_DE', marketplace_id: 'A1PA' });
  assert.ok(!('value' in drafts[0].valueTemplate.item_name));
});

test('extract 查不到亮点字段时不猜名字,而是留 null 并提示查 schema', () => {
  const { drafts, notes } = extractDrafts([RAW_ITEM]);
  assert.equal(drafts[0].attributes.highlights, null);
  assert.ok(notes.some((n) => /不要猜字段名/.test(n)));
  // 显式传入则采用,并借用 item_name 的选择符
  const withAttr = extractDrafts([RAW_ITEM], { highlightAttr: 'title_differentiation' });
  assert.equal(withAttr.drafts[0].attributes.highlights, 'title_differentiation');
  assert.deepEqual(withAttr.drafts[0].valueTemplate.title_differentiation,
    { language_tag: 'de_DE', marketplace_id: 'A1PA' });
});

// ───────────────────────────────── 跨条目检查

test('多条标题完全相同直接报错', () => {
  const same = 'Demobrand Sicherheitsarmband für Kinder 2,5 m mit Schlüssel';
  const findings = checkBatch([
    { sku: 'A', marketplace: 'DE', title: same },
    { sku: 'B', marketplace: 'DE', title: same },
    { sku: 'C', marketplace: 'DE', title: same },
  ]);
  const dup = findings.find((f) => f.code === 'E_DUPLICATE_TITLE');
  assert.ok(dup);
  assert.equal(dup.severity, 'error');
  assert.deepEqual(dup.skus, ['A', 'B', 'C']);
});

test('标题只差一个区分词时只警告,并指出差异', () => {
  const findings = checkBatch([
    { sku: 'A', marketplace: 'DE', title: 'Demobrand Anti-Verlustleine für Kinder 2,5 m, Grün' },
    { sku: 'B', marketplace: 'DE', title: 'Demobrand Anti-Verlustleine für Kinder 2,5 m, Rosa' },
  ]);
  assert.ok(!findings.some((f) => f.code === 'E_DUPLICATE_TITLE'));
  const sim = findings.find((f) => f.code === 'W_SIMILAR_TITLE');
  assert.ok(sim);
  assert.equal(sim.severity, 'warning');
  assert.match(sim.message, /grün|rosa/i);
});

test('不同商品的标题不会被误判', () => {
  const findings = checkBatch([
    { sku: 'A', marketplace: 'DE', title: 'Demobrand Anti-Verlustleine für Kinder 2,5 m, Grün' },
    { sku: 'B', marketplace: 'DE', title: 'Demobrand Fahrrad Rahmentasche wasserdicht, bis 6,7 Zoll' },
  ]);
  assert.equal(findings.length, 0);
});

test('五点整组照搬时警告', () => {
  const bullets = ['Erste Zeile mit genug Text.', 'Zweite Zeile mit genug Text.'];
  const findings = checkBatch([
    { sku: 'A', marketplace: 'DE', title: 'Demobrand Leine Grün', bullets },
    { sku: 'B', marketplace: 'DE', title: 'Demobrand Tasche Schwarz', bullets },
  ]);
  assert.ok(findings.some((f) => f.code === 'W_DUPLICATE_BULLETS'));
});

test('aggregateFindings 按 code 聚合并记录 SKU', () => {
  const agg = aggregateFindings([
    { sku: 'A', warnings: [{ code: 'W_BELOW_TARGET', message: 'x' }, { code: 'W_BELOW_TARGET', message: 'x' }] },
    { sku: 'B', warnings: [{ code: 'W_BELOW_TARGET', message: 'x' }, { code: 'W_SIMILAR', message: 'y' }] },
  ], 'warnings');
  assert.equal(agg[0].code, 'W_BELOW_TARGET');
  assert.equal(agg[0].count, 3);
  assert.deepEqual(agg[0].skus, ['A', 'B']);
});

// ───────────────────────────────── 对照报告

test('report 逐条摆五点,漏不掉', () => {
  const text = renderReport(baseDraft({
    currentTitle: 'Alter Titel ohne Marke',
    currentBullets: ['ALTE ERSTE ZEILE mit Grossbuchstaben.', 'Alte zweite Zeile.'],
    bullets: ['Neue erste Zeile mit genug Text drin fuer den Test.',
      'Neue zweite Zeile mit genug Text drin fuer den Test.',
      'Neue dritte Zeile mit genug Text drin fuer den Test.'],
  }));
  assert.match(text, /五点  2 条 → 3 条/);
  for (const n of [1, 2, 3]) assert.match(text, new RegExp(`\\[${n}\\]`), `缺第 ${n} 条`);
  assert.match(text, /当前：ALTE ERSTE ZEILE/);
  assert.match(text, /新版：Neue dritte Zeile/);
});

test('report 带现状体检:当前值的问题也要报出来', () => {
  const text = renderReport(baseDraft({
    currentTitle: 'Alter Titel ohne Marke, viel zu lang '.repeat(3),
    currentBullets: ['ALTE ZEILE mit Grossbuchstaben und genug Text fuer den Test.'],
  }));
  assert.match(text, /现状校验：❌/);
  assert.match(text, /超出上限|全大写|标题没以品牌开头/);
  assert.match(text, /新版校验：/);
});

test('report 没给选词依据时强制标出来', () => {
  assert.match(renderReport(baseDraft()), /选词依据：⚠️ 未提供/);
  assert.match(
    renderReport(baseDraft({ keywordEvidence: '广告搜索词报表 purchases7d=18' })),
    /选词依据：广告搜索词报表/,
  );
});

test('summarizeErrors 汇总成人话', () => {
  assert.equal(
    summarizeErrors([
      { code: 'E_TOO_LONG' }, { code: 'E_TOO_LONG' }, { code: 'E_ALL_CAPS' },
    ]),
    '超出上限×2、全大写×1',
  );
});

// ───────────────────────────────── patch 组装

test('buildPatches 用当前值模板保留 marketplace_id / language_tag', () => {
  const patches = buildPatches(baseDraft({
    attributes: { title: 'item_name', highlights: 'item_highlight' },
    valueTemplate: {
      item_name: { marketplace_id: 'ATVPDKIKX0DER', language_tag: 'en_US' },
      item_highlight: { marketplace_id: 'ATVPDKIKX0DER', language_tag: 'en_US' },
    },
  }));
  assert.equal(patches.length, 2);
  assert.deepEqual(patches[0], {
    op: 'replace',
    path: '/attributes/item_name',
    value: [{
      marketplace_id: 'ATVPDKIKX0DER',
      language_tag: 'en_US',
      value: 'Demobrand Wheat Straw Serving Tray, 22.5 x 31 cm Rectangular',
    }],
  });
});

test('buildPatches 把五点摊成同一属性下的多个 value 对象', () => {
  const patches = buildPatches(baseDraft({
    highlights: null,
    bullets: ['第一条', '第二条', '  ', '第三条'],
    attributes: { title: 'item_name', bullets: 'bullet_point' },
    valueTemplate: {
      item_name: { marketplace_id: 'ATVPDKIKX0DER' },
      bullet_point: { marketplace_id: 'ATVPDKIKX0DER', language_tag: 'en_US' },
    },
  }));
  const bulletPatch = patches.find((p) => p.path === '/attributes/bullet_point');
  assert.equal(bulletPatch.value.length, 3, '空白条目应被丢弃');
  assert.deepEqual(bulletPatch.value[1], {
    marketplace_id: 'ATVPDKIKX0DER', language_tag: 'en_US', value: '第二条',
  });
});

test('buildPatches 缺属性名或模板时报错,不猜字段', () => {
  assert.throws(() => buildPatches(baseDraft({ highlights: null })), /attributes\.title/);
  assert.throws(
    () => buildPatches(baseDraft({ highlights: null, attributes: { title: 'item_name' } })),
    /valueTemplate/,
  );
});

test('safeFileName 去掉路径分隔符等危险字符', () => {
  assert.equal(safeFileName('A/B\\C:D'), 'A_B_C_D');
  assert.equal(safeFileName('DEMO-TRAY_01.v2'), 'DEMO-TRAY_01.v2');
});

// ───────────────────────────────── CLI 行为

function runCli(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      encoding: 'utf8', cwd,
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '' };
  }
}

test('check 子命令:通过退出 0,失败退出 1', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'title-check-'));
  try {
    const good = path.join(dir, 'good.json');
    writeFileSync(good, JSON.stringify([baseDraft()]), 'utf8');
    const okRun = runCli(['check', '--file', good]);
    assert.equal(okRun.code, 0);
    assert.equal(JSON.parse(okRun.stdout).ok, true);

    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify([baseDraft({ title: 'Demobrand Best Tray!' })]), 'utf8');
    const failRun = runCli(['check', '--file', bad]);
    assert.equal(failRun.code, 1);
    assert.equal(JSON.parse(failRun.stdout).failed, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('patches 子命令:校验没过时拒绝生成', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'title-patch-'));
  try {
    const file = path.join(dir, 'bad.json');
    writeFileSync(file, JSON.stringify([baseDraft({
      title: 'Demobrand Best Tray',
      attributes: { title: 'item_name' },
      valueTemplate: { item_name: { marketplace_id: 'ATVPDKIKX0DER' } },
    })]), 'utf8');
    const run = runCli(['patches', '--file', file, '--out-dir', path.join(dir, 'out')]);
    assert.equal(run.code, 1);
    assert.match(JSON.parse(run.stdout).reason, /拒绝生成 patch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('patches 子命令:写出 patch 文件、索引和预览命令', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'title-patch-ok-'));
  try {
    const file = path.join(dir, 'drafts.json');
    writeFileSync(file, JSON.stringify([baseDraft({
      attributes: { title: 'item_name', highlights: 'item_highlight' },
      valueTemplate: {
        item_name: { marketplace_id: 'ATVPDKIKX0DER' },
        item_highlight: { marketplace_id: 'ATVPDKIKX0DER' },
      },
    })]), 'utf8');
    const outDir = path.join(dir, 'out');
    const run = runCli(['patches', '--file', file, '--out-dir', outDir, '--account', 'shop-b']);
    assert.equal(run.code, 0);
    const result = JSON.parse(run.stdout);
    assert.equal(result.count, 1);

    const patches = JSON.parse(readFileSync(result.index[0].patchFile, 'utf8'));
    assert.equal(patches.length, 2);

    const commands = readFileSync(result.commandFile, 'utf8');
    assert.match(commands, /--account shop-b/);
    assert.match(commands, /--dry-run/);
    assert.ok(!commands.includes('--confirm'), '预览文件不应包含 confirm 命令');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
