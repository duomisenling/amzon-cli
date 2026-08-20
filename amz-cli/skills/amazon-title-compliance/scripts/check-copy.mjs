#!/usr/bin/env node
//
// check-copy —— 标题/亮点文案的机器校验 + JSON Patch 组装
//
// 为什么必须有这个脚本:模型自己数字符数不可靠。说"标题 68 字符"实际常是 82,
// 德语复合词尤其严重,搜索词的 249 **字节**限制更是基本没概念。
// 所以生成完一律用代码验,不过就带着具体错误退回重写。
//
//   check    校验草稿(字符数/字节数/禁用字符/全大写/重复词/违禁词/跨字段重复)
//   patches  把通过校验的草稿组装成 listing update 用的 JSON Patch 文件
//
// 规则依据见 ../references/rules-2026.md;上限是亚马逊定的,不要在这里放宽。
// 无外部依赖,只用 Node 内置模块。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ───────────────────────────────────────── 常量表

/** 硬上限(亚马逊定的,不可放宽)。媒体类目标题仍是 200。 */
const LIMIT = {
  title: 75,
  titleMedia: 200,
  highlights: 125,
  searchTermsBytes: 249,
  bullets: 5,
  // 五点单条:**硬上限用 schema 的 700**(API 真会拒的那条线),
  // 255 只作为**警告**线。
  //
  // 为什么 255 不做成 error:它的来源只有第三方文章,而实测有反证——
  // 同一店铺 30 条在架五点里 57% 超过 255(最长 382),且 250~260 区间
  // 一条都没有,看不到任何被截断的痕迹。没有证据支撑就不该拦人干活。
  // 对比标题 75:公告 + schema description 双重一手证据,亚马逊还明确
  // 用 AI 改写来执行 —— 那条才配当 error。
  bulletCharsHard: 700,
  bulletChars: 255,
  bulletCharsMin: 10,
};

/** 目标区间(只是目标,不达标只警告)。按语言分:复合词语言写不下英语的区间。 */
const TARGET = {
  英语: { title: [45, 65], highlights: [100, 120] },
  德语: { title: [55, 72], highlights: [95, 122] },
  荷兰语: { title: [55, 72], highlights: [95, 122] },
  瑞典语: { title: [55, 72], highlights: [95, 122] },
  波兰语: { title: [55, 72], highlights: [95, 122] },
  法语: { title: [50, 70], highlights: [100, 122] },
  意大利语: { title: [50, 70], highlights: [100, 122] },
  西班牙语: { title: [50, 70], highlights: [100, 122] },
  葡萄牙语: { title: [50, 70], highlights: [100, 122] },
};

/**
 * 单条五点的目标区间。上限 250 贴着第三方给的 255 口径留点余量;
 * 超了只警告不拦(那条口径没有一手证据,见 LIMIT 的注释)。
 */
const BULLET_TARGET = [150, 250];

const SITE_LANGUAGE = {
  DE: '德语', UK: '英语', GB: '英语', US: '英语', CA: '英语', IE: '英语',
  FR: '法语', IT: '意大利语', ES: '西班牙语', NL: '荷兰语', BE: '荷兰语',
  PL: '波兰语', SE: '瑞典语', BR: '葡萄牙语', MX: '西班牙语',
};

/** 冠词/介词/连词:不计入"同一个词最多两次",也不算跨字段重复。 */
const STOPWORDS = {
  英语: 'a an the and or for of to in on at with by from as is are be this that your our it its no not',
  德语: 'der die das den dem des ein eine einen einem einer und oder für von zu in mit auf aus im am bei ist sind',
  法语: 'le la les un une des du de à en et ou pour avec sur dans par au aux est sont',
  西班牙语: 'el la los las un una unos unas y o para de del a en con por es son',
  意大利语: 'il lo la i gli le un uno una e o per di del della a in con da è sono',
  荷兰语: 'de het een en of voor van te in met op aan bij is zijn',
  波兰语: 'i lub dla z w na do od po za jest',
  瑞典语: 'en ett och eller för av till i med på är',
  葡萄牙语: 'o a os as um uma e ou para de do da em com por é são',
};

/** 无条件违禁词/短语。写了就是违规,与产品好坏无关。 */
const BANNED_PHRASES = [
  // 绝对化承诺
  'guaranteed', 'guarantee', '100%', 'never fails', 'risk free', 'riskfree',
  'permanent', 'instant',
  // 无根据最高级
  'best', 'best seller', 'bestseller', 'top rated', 'award winning',
  'proven', 'amazing', '#1', 'no.1', 'number one',
  // perfect 家族:实测漏网。"perfekte Alternative" 这类在德语文案里极常见
  'perfect', 'perfectly', 'flawless', 'unbeatable', 'ultimate',
  'perfekt', 'perfekte', 'perfekter', 'perfektes', 'erstklassig', 'erstklassige',
  'erstklassiges', 'unschlagbar', 'parfait', 'parfaite', 'perfetto', 'perfetta',
  'perfecto', 'perfecta', 'perfeito', 'perfeita', 'perfect', 'onovertroffen',
  // 健康医疗宣称
  'cure', 'cures', 'heal', 'heals', 'anti-viral', 'antiviral',
  'antibacterial', 'antibacterials', '抗菌',
  // 促销/价格/状况
  'free shipping', 'on sale', 'discount', 'cheap', 'buy now', 'limited time',
  'sale', 'clearance', 'lowest price', 'brand new',
  // 其他语言
  'garantiert', 'garantie', 'beste', 'bester', 'bestes', 'kostenlos', 'gratis',
  'rabatt', 'angebot', 'sofort', 'dauerhaft', 'antibakteriell',
  'garanti', 'meilleur', 'meilleure', 'remise', 'promotion', 'antibactérien',
  'garantizado', 'garantía', 'mejor', 'descuento', 'oferta', 'antibacteriano',
  'garantito', 'garanzia', 'migliore', 'sconto', 'offerta', 'antibatterico',
  'gegarandeerd', 'korting', 'aanbieding', 'antibacterieel',
  'gwarantowane', 'gwarancja', 'najlepszy', 'darmowy', 'zniżka',
  'garanterad', 'bäst', 'bästa', 'erbjudande',
  'garantido', 'melhor', 'grátis', 'desconto',
];

/** 有认证凭证才可用。校验器无法核实凭证,只能提醒人确认。 */
const NEEDS_EVIDENCE = [
  'eco-friendly', 'eco friendly', 'sustainable', 'biodegradable', 'non-toxic',
  'non toxic', 'chemical-free', 'chemical free', 'bpa-free', 'bpa free',
  'hypoallergenic', 'organic', 'food grade', 'food-grade', 'waterproof',
  // 德语:实测 BPA-frei 曾整条漏过——原表只有英语 'bpa free',
  // 而 normalizeForPhrase 后德语是 'bpa frei',两者不相等。
  'umweltfreundlich', 'umweltfreundliche', 'schadstofffrei', 'lebensmittelecht',
  'bpa frei', 'bpa-frei', 'nachhaltig', 'nachhaltige', 'biologisch abbaubar',
  'antiallergen', 'wasserdicht', 'rostfrei',
  // 法/西/意/荷/葡
  'écologique', 'sans bpa', 'biodégradable',
  'ecológico', 'sin bpa', 'biodegradable',
  'ecologico', 'senza bpa', 'biodegradabile',
  'milieuvriendelijk', 'bpa vrij', 'biologisch afbreekbaar',
  'ecológico', 'sem bpa',
];

/** 禁用特殊字符(品牌名内除外)。 */
const BANNED_CHARS = ['!', '$', '?', '_', '{', '}', '^', '¬', '¦'];

/**
 * 另一类禁用符号:商标/货币/版权号和全角括号。
 * 全角括号【】《》是中文排版习惯,德语/英语 listing 里出现一律是从中文素材直接搬过来的。
 */
const BANNED_SYMBOLS = [
  '™', '®', '©', '€', '£', '¥', '¢', '…', '†', '‡', '±',
  '【', '】', '《', '》', '〈', '〉', '「', '」', '『', '』',
];

/**
 * emoji 检测。**这是店铺硬规矩:一律不许出现表情**(2026-08-17 用户明确要求)。
 * 证据状态:第三方资料说亚马逊禁 emoji,但实测本店有五点以 🚴📱☔ 开头、
 * 370+ 字符、原样活着——没观察到亚马逊执行。所以它按 house-rule 拦,不冒充合规要求。
 * 用 Extended_Pictographic 覆盖绝大多数 emoji(含无变体选择符的单码点)。
 */
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

/**
 * 移动端标题截断线(字符)。前 30~40 字符权重最高,且是手机上实际显示的部分——
 * 主关键词落在这条线之后,等于绝大多数买家根本看不到它。
 */
const MOBILE_TRUNCATION = 40;

/**
 * 五点第一条的"弱开头"词。第 1 条五点是仅次于标题的权重位,
 * 句首用虚词等于把最贵的位置浪费掉——应该用本条最重的关键词开头。
 */
const WEAK_OPENERS = {
  英语: 'whether designed perfect ideal great made our this these with when if you we it there include includes featuring',
  德语: 'ob perfekt ideal unser unsere dieser diese dieses mit wenn sie es entwickelt hergestellt',
  法语: 'que parfait idéal notre nos ce cette avec quand vous il conçu fabriqué',
  西班牙语: 'ya perfecto ideal nuestro nuestra este esta con cuando usted diseñado fabricado',
  意大利语: 'che perfetto ideale nostro nostra questo questa con quando lei progettato realizzato',
  荷兰语: 'of perfect ideaal onze deze dit met wanneer ontworpen gemaakt',
  波兰语: 'czy idealny nasz nasza ten ta to z gdy zaprojektowany',
  瑞典语: 'om perfekt idealisk vår vårt denna detta med när designad tillverkad',
  葡萄牙语: 'se perfeito ideal nosso nossa este esta com quando projetado fabricado',
};

// ───────────────────────────────────────── 小工具

/** 字符数按码点算(不是 UTF-16 长度),避免变音符号/emoji 被算成两个。 */
export function charLength(text) {
  return [...String(text ?? '')].length;
}

/** 搜索词是字节限制,不是字符限制:重音字母占 2 字节。 */
export function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

/** 切词:只保留字母和数字序列,大小写归一由调用方决定。 */
export function tokenize(text) {
  return String(text ?? '').match(/[\p{L}\p{N}]+/gu) ?? [];
}

function stopwordSet(language) {
  const raw = STOPWORDS[language] ?? STOPWORDS['英语'];
  return new Set(raw.split(/\s+/));
}

/** 归一化用于短语匹配:小写 + 连字符/下划线/斜杠当空格 + 压缩空白。 */
function normalizeForPhrase(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 短语在文本中是否作为独立词出现。
 * 前后只有在短语本身以字母/数字开头或结尾时才加边界断言——
 * 否则 "#1" / "100%" 这种带符号的短语永远匹配不上。
 */
export function containsPhrase(text, phrase) {
  const haystack = normalizeForPhrase(text);
  const needle = normalizeForPhrase(phrase);
  if (!haystack || !needle) return false;
  const head = /^[\p{L}\p{N}]/u.test(needle) ? '(?<![\\p{L}\\p{N}])' : '';
  const tail = /[\p{L}\p{N}]$/u.test(needle) ? '(?![\\p{L}\\p{N}])' : '';
  return new RegExp(`${head}${escapeRegExp(needle)}${tail}`, 'u').test(haystack);
}

/** 从文本里剔掉品牌名(大小写不敏感),避免品牌自带的字符/大写被误判。 */
function stripBrand(text, brand) {
  if (!brand) return String(text ?? '');
  const pattern = new RegExp(escapeRegExp(String(brand)), 'gi');
  return String(text ?? '').replace(pattern, ' ');
}

// ───────────────────────────────────────── 各项校验

function checkLength(field, text, limit, target, out) {
  const n = charLength(text);
  if (n > limit) {
    out.errors.push({
      code: 'E_TOO_LONG',
      field,
      message: `${field} ${n} 字符,超过硬上限 ${limit}。必须压缩,不能提交。`,
    });
    return n;
  }
  if (target) {
    const [lo, hi] = target;
    if (n > hi) {
      out.warnings.push({
        code: 'W_ABOVE_TARGET',
        field,
        message: `${field} ${n} 字符,超过目标区间 ${lo}-${hi}(仍在上限内)。留点余量更稳。`,
      });
    } else if (n < lo) {
      out.warnings.push({
        code: 'W_BELOW_TARGET',
        field,
        message: `${field} ${n} 字符,低于目标下限 ${lo}。素材不足写短是对的,但确认没有可用信息被漏掉。`,
      });
    }
  }
  return n;
}

function checkBannedChars(field, text, brand, out) {
  const stripped = stripBrand(text, brand);
  const hits = [...BANNED_CHARS, ...BANNED_SYMBOLS].filter((ch) => stripped.includes(ch));
  if (hits.length) {
    out.errors.push({
      code: 'E_BANNED_CHAR',
      field,
      message: `${field} 含禁用特殊字符 ${hits.join(' ')}(品牌名内除外)。` +
        '全角括号【】《》一般是从中文素材直接搬过来的,要换成普通标点或删掉。',
    });
  }
  const emoji = [...new Set(stripped.match(EMOJI_RE) ?? [])];
  if (emoji.length) {
    out.errors.push({
      code: 'E_EMOJI',
      field,
      evidence: 'house-rule',
      message: `${field} 含 emoji ${emoji.join(' ')}。**本店硬规矩:标题、亮点、五点一律不许出现表情。**` +
        '(第三方资料也说亚马逊禁 emoji,但本店未观察到执行——所以这条按店铺标准拦,不是按已验证的合规要求拦。' +
        '两者结论一样:删掉。)',
    });
  }
}

function checkAllCaps(field, text, brand, allowCaps, out) {
  const allow = new Set([...(allowCaps ?? [])].map((w) => String(w).toUpperCase()));
  const hits = [];
  for (const token of tokenize(stripBrand(text, brand))) {
    const letters = token.replace(/[\p{N}]/gu, '');
    if (letters.length < 4) continue; // USB / LED / BPA / ABS 这类缩写放行
    if (letters !== letters.toUpperCase()) continue;
    if (letters.toLowerCase() === letters) continue; // 纯非大小写文字(中日韩)
    if (allow.has(token.toUpperCase())) continue;
    hits.push(token);
  }
  if (hits.length) {
    out.errors.push({
      code: 'E_ALL_CAPS',
      field,
      message: `${field} 含全大写单词 ${hits.join('、')}。亚马逊视同"喊话"按垃圾信息处理;` +
        '缩写和品牌名例外,确属例外请加进草稿的 allowCaps。',
    });
  }
}

function checkWordRepeat(field, text, language, out) {
  const stop = stopwordSet(language);
  const counts = new Map();
  for (const token of tokenize(text)) {
    const key = token.toLowerCase();
    if (stop.has(key)) continue; // 冠词/介词/连词不计
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const hits = [...counts.entries()].filter(([, n]) => n > 2);
  if (hits.length) {
    out.errors.push({
      code: 'E_WORD_REPEAT',
      field,
      message: `${field} 里这些词出现超过两次:${hits.map(([w, n]) => `${w}×${n}`).join('、')}。` +
        '同一个词最多两次(冠词/介词/连词除外)。',
    });
  }
}

/**
 * 主关键词必须出现在标题里,而且要落在移动端截断线之内。
 * 位置按**码点**算,和 charLength 一个口径。
 */
function checkMainKeyword(title, mainKeyword, out) {
  if (!mainKeyword) return;
  const needle = String(mainKeyword).trim();
  if (!needle) return;
  const chars = [...String(title)];
  const lowerTitle = chars.map((c) => c.toLowerCase()).join('');
  const index = lowerTitle.indexOf(needle.toLowerCase());
  if (index < 0) {
    out.errors.push({
      code: 'E_MAIN_KEYWORD_MISSING',
      field: 'title',
      message: `主关键词「${needle}」没有出现在标题里。标题只放一个主词,而且必须紧跟品牌。`,
    });
    return;
  }
  // indexOf 返回的是小写拼接串的下标 —— 因为逐字符小写后长度可能变化(如 İ),
  // 用切片重新按码点数一次,保证和 charLength 同口径。
  const position = [...lowerTitle.slice(0, index)].length;
  if (position > MOBILE_TRUNCATION) {
    out.warnings.push({
      code: 'W_MAIN_KEYWORD_LATE',
      field: 'title',
      message: `主关键词「${needle}」从第 ${position + 1} 个字符才开始,超过移动端截断线 ` +
        `${MOBILE_TRUNCATION}。手机上买家多半看不到它,把它提到紧跟品牌的位置。`,
    });
  }
}

function checkBannedWords(field, text, out) {
  const banned = BANNED_PHRASES.filter((p) => containsPhrase(text, p));
  if (banned.length) {
    out.errors.push({
      code: 'E_BANNED_WORD',
      field,
      message: `${field} 含无条件违禁词:${banned.join('、')}。` +
        '换成素材里确有的具体规格,不要用空泛最高级。',
    });
  }
  const evidence = NEEDS_EVIDENCE.filter((p) => containsPhrase(text, p));
  if (evidence.length) {
    out.warnings.push({
      code: 'W_NEEDS_EVIDENCE',
      field,
      message: `${field} 含"有凭证才可用"的词:${evidence.join('、')}。` +
        '素材里必须有具体认证名称或报告编号才能保留,否则删掉并记进 omitted。',
    });
  }
}

function checkThirdPartyBrands(field, text, brands, out) {
  const hits = (brands ?? []).filter((b) => containsPhrase(text, b));
  if (hits.length) {
    out.errors.push({
      code: 'E_THIRD_PARTY_BRAND',
      field,
      message: `${field} 出现第三方品牌 ${hits.join('、')}。标题和亮点都显示在搜索结果页,` +
        '品牌方可据此投诉。兼容信息改放五点和后台搜索词。',
    });
  }
}

/** 标题↔亮点严禁重复:比的是实词,停用词、品牌和纯数字不算。 */
function checkOverlap(title, highlights, language, brand, allowOverlap, out) {
  if (!title || !highlights) return;
  const stop = stopwordSet(language);
  const brandTokens = new Set(tokenize(brand).map((t) => t.toLowerCase()));
  const allow = new Set((allowOverlap ?? []).map((w) => String(w).toLowerCase()));
  const content = (text) => new Set(
    tokenize(text)
      .map((t) => t.toLowerCase())
      .filter((t) => t.length >= 3 && !stop.has(t) && !brandTokens.has(t)
        && !allow.has(t) && !/^\p{N}+$/u.test(t)),
  );
  const inTitle = content(title);
  const shared = [...content(highlights)].filter((t) => inTitle.has(t));
  if (shared.length) {
    out.errors.push({
      code: 'E_TITLE_HIGHLIGHT_OVERLAP',
      field: 'highlights',
      message: `标题与亮点重复用词:${shared.join('、')}。两者并列展示给同一个买家,` +
        '重复等于浪费黄金位;亮点要补标题没说的。确属必要请加进草稿的 allowOverlap。',
    });
  }
}

function checkSearchTerms(draft, out) {
  const terms = draft.searchTerms;
  if (!terms) return;
  const bytes = byteLength(terms);
  if (bytes > LIMIT.searchTermsBytes) {
    out.errors.push({
      code: 'E_TOO_LONG',
      field: 'searchTerms',
      message: `后台搜索词 ${bytes} 字节,超过上限 ${LIMIT.searchTermsBytes} 字节` +
        '(是字节不是字符,重音字母占 2 字节)。',
    });
  } else if (bytes > 200) {
    out.warnings.push({
      code: 'W_ABOVE_TARGET',
      field: 'searchTerms',
      message: `后台搜索词 ${bytes} 字节,建议控制在 200 字节以内留余量。`,
    });
  }
  if (terms.includes(',')) {
    out.warnings.push({
      code: 'W_SEARCH_TERMS_COMMA',
      field: 'searchTerms',
      message: '后台搜索词应空格分隔,不要用逗号。',
    });
  }
  const seen = new Set();
  const dup = new Set();
  for (const token of tokenize(terms).map((t) => t.toLowerCase())) {
    if (seen.has(token)) dup.add(token);
    seen.add(token);
  }
  if (dup.size) {
    out.warnings.push({
      code: 'W_SEARCH_TERMS_DUPLICATE',
      field: 'searchTerms',
      message: `后台搜索词内部重复:${[...dup].join('、')}。搜索词无位置权重,重复是浪费。`,
    });
  }
  const front = new Set([
    ...tokenize(draft.title ?? draft.currentTitle ?? ''),
    ...tokenize(draft.highlights ?? draft.currentHighlights ?? ''),
    ...tokenize((draft.bullets ?? []).join(' ')),
  ].map((t) => t.toLowerCase()));
  const reused = [...seen].filter((t) => front.has(t) && t.length >= 3);
  if (reused.length) {
    out.warnings.push({
      code: 'W_SEARCH_TERMS_REUSED',
      field: 'searchTerms',
      message: `搜索词里这些词前台已用过:${reused.join('、')}。` +
        '搜索词只放前面四处都没用过的长尾、同义词和常见错拼。',
    });
  }
}

/**
 * 五点校验。
 *
 * 全大写在五点里**也是禁的**——不是风格建议。Amazon 在 bullet_point 的
 * schema 说明里原话:「KEINE Wörter in Großbuchstaben oder Abkürzungen
 * verwenden.」(不要使用全大写单词或缩写)。同一段还要求不要拿五点写
 * 材质成分 / 护理说明 / 原产国(那些有专门字段)——那条没法用代码判,写在文档里。
 *
 * 注意两处**故意不做**的检查:
 *   - 第三方品牌:五点**允许**写(「适配 Sony WH-CH720N」正是买家要看的信息)。
 *     禁令只作用于标题和亮点,因为那两处显示在搜索结果页,曝光面最大。
 *   - 与标题重复:规则只禁「标题↔亮点」重复,五点复述标题里的词是允许的。
 */
function checkBullets(bullets, language, brand, allowCaps, out) {
  if (!Array.isArray(bullets) || bullets.length === 0) return;
  if (bullets.length > LIMIT.bullets) {
    out.errors.push({
      code: 'E_TOO_MANY_BULLETS',
      field: 'bullets',
      message: `五点 ${bullets.length} 条,超过 ${LIMIT.bullets} 条。`,
    });
  }
  bullets.forEach((bullet, index) => {
    const field = `bullets[${index}]`;
    const n = charLength(bullet);
    if (n === 0) {
      out.errors.push({
        code: 'E_EMPTY_BULLET',
        field,
        message: `第 ${index + 1} 条五点为空。写不出就少写一条,不要留空。`,
      });
      return;
    }
    if (n > LIMIT.bulletCharsHard) {
      out.errors.push({
        code: 'E_TOO_LONG',
        field,
        message: `第 ${index + 1} 条五点 ${n} 字符,超过 schema 硬上限 ${LIMIT.bulletCharsHard},API 会直接拒。`,
      });
    } else if (n > LIMIT.bulletChars) {
      out.warnings.push({
        code: 'W_ABOVE_POLICY',
        field,
        evidence: 'third-party',
        message: `第 ${index + 1} 条五点 ${n} 字符,超过第三方资料给的政策口径 ${LIMIT.bulletChars}。` +
          '⚠️ 这条**没有一手证据**:实测同店 57% 在架五点超过它且未见截断。' +
          '想稳妥就压到 255 以内,但不必为它砍掉有依据的内容。',
      });
    } else if (n < LIMIT.bulletCharsMin) {
      out.errors.push({
        code: 'E_TOO_SHORT',
        field,
        message: `第 ${index + 1} 条五点只有 ${n} 字符,低于最少 ${LIMIT.bulletCharsMin} 字符。`,
      });
    } else if (n > BULLET_TARGET[1]) {
      out.warnings.push({
        code: 'W_ABOVE_TARGET',
        field,
        message: `第 ${index + 1} 条五点 ${n} 字符,超过目标 ${BULLET_TARGET[1]}(政策线 ${LIMIT.bulletChars})。留点余量更稳。`,
      });
    } else if (n < BULLET_TARGET[0]) {
      out.warnings.push({
        code: 'W_BELOW_TARGET',
        field,
        message: `第 ${index + 1} 条五点只有 ${n} 字符,低于目标 ${BULLET_TARGET[0]}。` +
          `单条可用到 ${LIMIT.bulletChars} 字符,素材里有依据的内容别浪费这个位置。`,
      });
    }
    // 五点是违禁词重灾区:绝对化承诺和无根据最高级最容易写在这里
    checkBannedWords(field, bullet, out);
    // Amazon 的 bullet_point schema 说明明确禁止全大写单词
    checkAllCaps(field, bullet, brand, allowCaps, out);
    // emoji 和全角括号在五点里最常见(从中文素材搬来的)
    checkBannedChars(field, bullet, brand, out);
  });

  // 第 1 条五点是仅次于标题的权重位,句首不能浪费在虚词上
  const first = String(bullets[0] ?? '');
  const opener = tokenize(first)[0]?.toLowerCase();
  if (opener) {
    const weak = new Set(
      (WEAK_OPENERS[language] ?? WEAK_OPENERS['英语']).split(/\s+/),
    );
    if (weak.has(opener) || stopwordSet(language).has(opener)) {
      out.warnings.push({
        code: 'W_WEAK_BULLET_OPENER',
        field: 'bullets[0]',
        message: `第 1 条五点以「${opener}」开头。这是仅次于标题的权重位,` +
          '句首应该是本条最重的关键词,不要用虚词把最贵的位置浪费掉。',
      });
    }
  }

  // 每条五点必须覆盖不同维度:两条讲同一件事就是白占一个位置
  const stop = stopwordSet(language);
  const content = bullets.map((bullet) => new Set(
    tokenize(bullet)
      .map((t) => t.toLowerCase())
      .filter((t) => t.length >= 4 && !stop.has(t) && !/^\p{N}+$/u.test(t)),
  ));
  for (let i = 0; i < content.length; i += 1) {
    for (let j = i + 1; j < content.length; j += 1) {
      const shared = [...content[i]].filter((t) => content[j].has(t));
      if (shared.length >= 3) {
        out.warnings.push({
          code: 'W_BULLET_OVERLAP',
          field: `bullets[${j}]`,
          message: `第 ${i + 1} 条和第 ${j + 1} 条五点重合用词:${shared.slice(0, 5).join('、')}。` +
            '两条讲同一件事等于白占一个位置,合并成一条,空出来的写别的维度。',
        });
      }
    }
  }
}

/**
 * 整套完整性:优化的产出必须是**一整套**新文案,不是打补丁。
 *
 * 标题砍到 75 字符后,删掉的词要由亮点承接、五点要重新分配维度——
 * 只交其中一个字段,另外两个必然和它对不上。所以 --complete 模式下
 * 三个字段缺一不可。
 *
 * 五点少于 3 条不算一套;3~4 条只警告,因为「素材不足就写短」优先级更高,
 * 不能为了凑满 5 条编造(铁律一 > 完整性)。
 */
function checkCompleteSet(draft, out) {
  const missing = [];
  if (draft.title == null || String(draft.title).trim() === '') missing.push('标题');
  if (draft.highlights == null || String(draft.highlights).trim() === '') missing.push('商品亮点');
  const bullets = Array.isArray(draft.bullets)
    ? draft.bullets.filter((b) => String(b ?? '').trim() !== '')
    : [];
  if (bullets.length < 3) missing.push(`五点(当前 ${bullets.length} 条,至少 3 条)`);

  if (missing.length) {
    out.errors.push({
      code: 'E_INCOMPLETE_SET',
      field: 'draft',
      message: `整套优化缺少:${missing.join('、')}。` +
        '标题、亮点、五点是咬合的一套——只交一部分,另外两个必然和它对不上。',
    });
  } else if (bullets.length < LIMIT.bullets) {
    out.warnings.push({
      code: 'W_BULLETS_NOT_FULL',
      field: 'bullets',
      message: `五点只有 ${bullets.length} 条,未写满 ${LIMIT.bullets} 条。` +
        '素材不足写短是对的(不许为凑数编造),但确认没有可用维度被漏掉。',
    });
  }
}

/** 亮点和五点讲同一件事:亮点位置金贵,应该补五点没说的。 */
function checkHighlightBulletOverlap(highlights, bullets, language, brand, out) {
  if (!highlights || !Array.isArray(bullets) || bullets.length === 0) return;
  const stop = stopwordSet(language);
  const brandTokens = new Set(tokenize(brand).map((t) => t.toLowerCase()));
  const words = (text) => new Set(
    tokenize(text)
      .map((t) => t.toLowerCase())
      .filter((t) => t.length >= 4 && !stop.has(t) && !brandTokens.has(t)
        && !/^\p{N}+$/u.test(t)),
  );
  const inHighlights = words(highlights);
  bullets.forEach((bullet, index) => {
    const shared = [...words(bullet)].filter((t) => inHighlights.has(t));
    if (shared.length >= 3) {
      out.warnings.push({
        code: 'W_HIGHLIGHT_BULLET_OVERLAP',
        field: `bullets[${index}]`,
        message: `亮点和第 ${index + 1} 条五点重合用词:${shared.slice(0, 5).join('、')}。` +
          '亮点只有 125 字符且显示在搜索结果页,应该补五点没说的,不要复述。',
      });
    }
  });
}

/**
 * 审计商品描述。**本 skill 不改描述**,但必须读它,原因有二:
 *
 *   1. 它是 <listing_local> 素材的一部分。实测漏读一次就丢了一个真事实
 *      ——「颜色是涂层(farbenfrohe Beschichtung)」,而我按不锈钢原色写了文案。
 *   2. 改完三个字段后,描述会和新文案**自相矛盾**(五点删掉了 BPA-frei,
 *      描述里还写着)。矛盾同时砸掉关键词层和语义层。
 *
 * 只出警告:这些是**现存**问题,不是本次产出的问题。要用户自己去改描述。
 */
function auditDescription(draft, out) {
  const text = draft.currentDescription;
  if (text == null || String(text).trim() === '') return;
  // 只查违禁词 / 需凭证词 / emoji。
  // **不查**标点(问号、感叹号在描述里合法,只有标题禁)和全大写——
  // 那两条是标题/亮点/五点的规则,套到描述上是误报(实测把
  // "Warum ... wählen?" 的问号报成了违规)。
  const probe = { errors: [], warnings: [] };
  checkBannedWords('description', text, probe);
  const emoji = [...new Set(String(text).match(EMOJI_RE) ?? [])];
  if (emoji.length) {
    probe.errors.push({ message: `description 含 emoji ${emoji.join(' ')}。` });
  }
  for (const f of [...probe.errors, ...probe.warnings]) {
    out.warnings.push({
      code: 'W_DESCRIPTION_ISSUE',
      field: 'currentDescription',
      message: `商品描述里已存在的问题(本次不改描述,但会和新文案矛盾):${f.message}`,
    });
  }
}

/** 校验单条草稿。返回 {sku, ok, errors, warnings, metrics}。 */
export function checkDraft(draft, options = {}) {
  const out = { errors: [], warnings: [] };
  const site = String(draft.marketplace ?? '').toUpperCase();
  const language = draft.language ?? SITE_LANGUAGE[site] ?? '英语';
  const target = TARGET[language] ?? TARGET['英语'];
  const titleLimit = draft.media ? LIMIT.titleMedia : LIMIT.title;
  const brand = draft.brand;
  const metrics = { language, titleLimit };

  if (draft.title != null && String(draft.title).trim() !== '') {
    const title = String(draft.title);
    metrics.titleChars = checkLength('title', title, titleLimit, target.title, out);
    checkBannedChars('title', title, brand, out);
    checkAllCaps('title', title, brand, draft.allowCaps, out);
    checkWordRepeat('title', title, language, out);
    checkMainKeyword(title, draft.mainKeyword, out);
    checkBannedWords('title', title, out);
    checkThirdPartyBrands('title', title, draft.thirdPartyBrands, out);
    if (brand) {
      const head = title.trim().toLowerCase();
      if (!head.startsWith(String(brand).trim().toLowerCase())) {
        out.errors.push({
          code: 'E_BRAND_NOT_FIRST',
          field: 'title',
          message: `标题必须以品牌「${brand}」开头,品牌后紧跟主关键词。`,
        });
      }
    }
  }

  if (draft.highlights != null && String(draft.highlights).trim() !== '') {
    const highlights = String(draft.highlights);
    metrics.highlightsChars = checkLength(
      'highlights', highlights, LIMIT.highlights, target.highlights, out,
    );
    checkBannedChars('highlights', highlights, brand, out);
    checkAllCaps('highlights', highlights, brand, draft.allowCaps, out);
    checkBannedWords('highlights', highlights, out);
    checkThirdPartyBrands('highlights', highlights, draft.thirdPartyBrands, out);

    // 前置条件:标题 ≤75 才能填亮点。本次不改标题时用现值判断。
    const effectiveTitle = draft.title ?? draft.currentTitle;
    if (effectiveTitle != null) {
      const n = charLength(effectiveTitle);
      if (n > titleLimit) {
        out.errors.push({
          code: 'E_HIGHLIGHTS_NOT_ELIGIBLE',
          field: 'highlights',
          message: `生效标题 ${n} 字符仍超过 ${titleLimit},此时亚马逊不会展示商品亮点。` +
            '先把标题改到上限内,或与标题同批提交。',
        });
      }
    } else {
      out.warnings.push({
        code: 'W_TITLE_UNKNOWN',
        field: 'highlights',
        message: '草稿没给 title 也没给 currentTitle,无法判断亮点的前置条件是否满足。',
      });
    }
  }

  checkOverlap(
    draft.title ?? draft.currentTitle,
    draft.highlights,
    language,
    brand,
    draft.allowOverlap,
    out,
  );
  checkHighlightBulletOverlap(
    draft.highlights,
    draft.bullets,
    language,
    brand,
    out,
  );
  checkBullets(draft.bullets, language, brand, draft.allowCaps, out);
  auditDescription(draft, out);
  checkSearchTerms(draft, out);
  if (options.requireComplete ?? draft.requireComplete) checkCompleteSet(draft, out);

  // 审现状模式:house-rule 类规则(禁 emoji 之类店铺自定标准)对**存量内容**只提示,
  // 不算错误——用户明确要求"之前就有的不要管",不能让它虚增改写理由。
  // 对**新写的稿子**仍然是 error(不带 --audit 时)。
  if (options.audit) {
    const kept = [];
    for (const e of out.errors) {
      if (e.evidence === 'house-rule') {
        out.warnings.push({ ...e, message: `[存量,不因此触发改写] ${e.message}` });
      } else {
        kept.push(e);
      }
    }
    out.errors.length = 0;
    out.errors.push(...kept);
  }

  if (draft.searchTerms) metrics.searchTermsBytes = byteLength(draft.searchTerms);
  if (Array.isArray(draft.bullets)) metrics.bulletCount = draft.bullets.length;

  return {
    sku: draft.sku ?? null,
    marketplace: site || null,
    ok: out.errors.length === 0,
    metrics,
    errors: out.errors,
    warnings: out.warnings,
  };
}

// ───────────────────────────────────────── patch 组装

/**
 * 组装 listing update 用的 JSON Patch 数组。
 *
 * 属性名和 value 对象结构**不在这里猜**:
 *   attributes  —— 由 `listing schema --grep` 查出来的真实属性名
 *   valueTemplate —— 取自该 SKU 的当前值对象(去掉 value 键),
 *                    因为当前值天然带着这个卖家/站点/产品类型正确的
 *                    marketplace_id、language_tag 等键。
 * 当前值为空(如首次填亮点)时,由调用方按 schema 给出模板。
 */
export function buildPatches(draft) {
  const attributes = draft.attributes ?? {};
  const templates = draft.valueTemplate ?? {};
  const patches = [];
  for (const field of ['title', 'highlights', 'bullets']) {
    const raw = draft[field];
    // 五点是多条:一个属性下挂多个 value 对象,顺序即前台展示顺序
    const values = field === 'bullets'
      ? (Array.isArray(raw) ? raw.filter((b) => String(b ?? '').trim() !== '') : [])
      : (raw == null || String(raw).trim() === '' ? [] : [raw]);
    if (values.length === 0) continue;
    const attribute = attributes[field];
    if (!attribute) {
      throw new Error(
        `${draft.sku ?? '(无 SKU)'}: 缺少 attributes.${field} —— ` +
        '请先用 `amz-cli listing schema --grep` 查出真实属性名,不要猜字段名',
      );
    }
    const template = templates[attribute];
    if (!template || typeof template !== 'object' || Array.isArray(template)) {
      throw new Error(
        `${draft.sku ?? '(无 SKU)'}: 缺少 valueTemplate["${attribute}"] —— ` +
        '请取该 SKU 当前值对象(去掉 value 键)作为模板;当前值为空时按 schema 结构给出',
      );
    }
    patches.push({
      op: 'replace',
      path: `/attributes/${attribute}`,
      value: values.map((value) => ({ ...template, value: String(value) })),
    });
  }
  if (patches.length === 0) {
    throw new Error(
      `${draft.sku ?? '(无 SKU)'}: 没有要写入的字段(title / highlights / bullets 都为空)`,
    );
  }
  return patches;
}

// ───────────────────────────────────────── 素材提取

/** listing sku 是 data.item,listing batch 的 jsonl 每行可能是 {item:…} 或直接摊平。 */
function unwrapItem(row) {
  if (row && typeof row === 'object') {
    if (row.data && row.data.item) return row.data.item;
    if (row.item) return row.item;
    if (row.attributes || row.summaries) return row;
  }
  return null;
}

/** 取某属性的值数组(每个元素是 {value,…} 或裸值)。 */
function attrValues(attributes, name) {
  const raw = attributes[name];
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => (x && typeof x === 'object' && 'value' in x ? x.value : x));
}

/** 从当前值对象拿 patch 用的模板:去掉 value,保留 marketplace_id / language_tag 等选择符。 */
function templateFrom(attributes, name) {
  const raw = attributes[name];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const first = raw[0];
  if (!first || typeof first !== 'object') return null;
  const { value, ...rest } = first;
  return Object.keys(rest).length ? rest : null;
}

/** 亮点字段名随产品类型而异,已知会叫 title_differentiation——但**不许猜**。 */
const HIGHLIGHT_CANDIDATES = ['title_differentiation', 'item_highlight', 'product_highlight'];

/**
 * 把 listing 原始返回直接摊成草稿骨架。
 *
 * 为什么要有它:漏字段这类失误只能靠"取消手写提取"来根治。实测手写脚本漏掉
 * product_description 一次,丢了「颜色是涂层」这个真事实,还没发现改完后
 * 描述会和新五点自相矛盾。文档里写"别漏"没用——那是清单型规则,散文里活不下去。
 *
 * 产出里 title / highlights / bullets 留空(那是你要写的),其余素材字段一次填满。
 */
export function extractDrafts(rows, options = {}) {
  const drafts = [];
  const notes = [];
  for (const row of rows) {
    const item = unwrapItem(row);
    if (!item) continue;
    const a = item.attributes ?? {};
    const summary = (item.summaries ?? [])[0] ?? {};
    const sku = item.sku ?? row.sku ?? null;
    const productType = summary.productType
      ?? ((item.productTypes ?? [])[0] ?? {}).productType ?? null;

    const highlightAttr = options.highlightAttr
      ?? HIGHLIGHT_CANDIDATES.find((name) => Object.prototype.hasOwnProperty.call(a, name))
      ?? null;
    if (!highlightAttr) {
      notes.push(`${sku}: 当前没有亮点字段(多半是没填过)。**不要猜字段名**——` +
        '跑 listing schema --grep highlight 查出真名后用 --highlight-attr 传进来。');
    }

    const titleTemplate = templateFrom(a, 'item_name');
    const valueTemplate = {};
    if (titleTemplate) valueTemplate['item_name'] = titleTemplate;
    if (templateFrom(a, 'bullet_point')) valueTemplate['bullet_point'] = templateFrom(a, 'bullet_point');
    if (highlightAttr) {
      // 亮点没填过时没有当前值可抄。选择符(marketplace_id/language_tag)与标题同套,
      // 拿 item_name 的模板兜底是安全的;仍在 notes 里点明来源。
      const own = templateFrom(a, highlightAttr);
      if (own) valueTemplate[highlightAttr] = own;
      else if (titleTemplate) {
        valueTemplate[highlightAttr] = titleTemplate;
        notes.push(`${sku}: 亮点 ${highlightAttr} 无当前值,valueTemplate 借用了 item_name 的选择符,写入前用 schema 核对。`);
      }
    }

    drafts.push({
      sku,
      marketplace: options.marketplace ?? null,
      productType,
      brand: attrValues(a, 'brand')[0] ?? null,
      mainKeyword: null,
      title: null,
      highlights: null,
      bullets: null,
      currentTitle: attrValues(a, 'item_name')[0] ?? '',
      currentHighlights: highlightAttr ? (attrValues(a, highlightAttr)[0] ?? '') : '',
      currentBullets: attrValues(a, 'bullet_point'),
      currentDescription: attrValues(a, 'product_description')[0] ?? '',
      sourceFacts: {
        asin: summary.asin ?? null,
        color: attrValues(a, 'color')[0] ?? null,
        material: attrValues(a, 'material')[0] ?? null,
        unitCount: attrValues(a, 'unit_count')[0] ?? null,
        specialFeature: attrValues(a, 'special_feature')[0] ?? null,
        countryOfOrigin: attrValues(a, 'country_of_origin')[0] ?? null,
        genericKeyword: attrValues(a, 'generic_keyword')[0] ?? null,
        parentSku: ((a.child_parent_sku_relationship ?? [])[0] ?? {}).parent_sku ?? null,
      },
      attributes: {
        title: 'item_name',
        highlights: highlightAttr,
        bullets: 'bullet_point',
      },
      valueTemplate,
      keywordEvidence: null,
      omitted: [],
      conflicts: [],
      notes: '',
    });
  }
  return { drafts, notes };
}

// ───────────────────────────────────────── 跨条目检查

/** 归一化成可比较的实词集合(小写、去停用词、去纯数字)。 */
function contentTokenSet(text, language) {
  const stop = stopwordSet(language);
  return new Set(
    tokenize(text)
      .map((t) => t.toLowerCase())
      .filter((t) => !stop.has(t) && !/^\p{N}+$/u.test(t)),
  );
}

/**
 * 两个标题「几乎一样」的判据:实词差异 ≤2 个,且共有实词 ≥3 个。
 *
 * 不用 Jaccard —— 标题实词本来就少(6~10 个),差一个颜色词 Jaccard 才 0.71,
 * 阈值定多少都不对。直接数差异词更贴合"只差一个区分维度"这件事。
 */
function nearlyIdentical(a, b) {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  const diff = (a.size - shared) + (b.size - shared);
  return { hit: diff > 0 && diff <= 2 && shared >= 3, shared, diff };
}

/**
 * 跨条目检查:单条视角看不见的问题。
 *
 * 实测动机:同一店铺三条独立 listing(儿童安全绳 绿/粉/蓝)标题**一字不差**,
 * 而且都不提颜色——买家在搜索结果里根本分不出该买哪个。逐条校验全都"通过",
 * 只有把整批放在一起比才看得出来。
 */
export function checkBatch(drafts) {
  const findings = [];
  const rows = drafts
    .map((d, index) => ({
      index,
      sku: d.sku ?? `#${index + 1}`,
      language: d.language ?? SITE_LANGUAGE[String(d.marketplace ?? '').toUpperCase()] ?? '英语',
      title: String(d.title ?? '').trim(),
      bullets: Array.isArray(d.bullets) ? d.bullets.map((b) => String(b ?? '').trim()) : [],
    }))
    .filter((r) => r.title !== '');

  // ① 标题完全相同 —— 直接报错。多条 listing 共用一个标题,买家无法区分,
  //    而且亚马逊也可能判为重复内容。
  const byNormalized = new Map();
  for (const r of rows) {
    const key = normalizeForPhrase(r.title);
    if (!byNormalized.has(key)) byNormalized.set(key, []);
    byNormalized.get(key).push(r.sku);
  }
  for (const [, skus] of byNormalized) {
    if (skus.length > 1) {
      findings.push({
        code: 'E_DUPLICATE_TITLE',
        severity: 'error',
        skus,
        message: `这 ${skus.length} 条的标题完全相同。多条 listing 共用一个标题,` +
          '买家在搜索结果里分不出该买哪个。每条必须带自己的区分维度' +
          '(颜色 / 尺寸 / 数量,以各自的 color、size、unit_count 属性为准)。',
      });
    }
  }

  // ② 标题高度相似但不完全相同 —— 只警告。差异词往往就是区分维度,
  //    要确认它够醒目(别埋在标题末尾被移动端截断)。
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      if (normalizeForPhrase(rows[i].title) === normalizeForPhrase(rows[j].title)) continue;
      const a = contentTokenSet(rows[i].title, rows[i].language);
      const b = contentTokenSet(rows[j].title, rows[j].language);
      if (nearlyIdentical(a, b).hit) {
        const diff = [...new Set([
          ...[...a].filter((t) => !b.has(t)),
          ...[...b].filter((t) => !a.has(t)),
        ])];
        findings.push({
          code: 'W_SIMILAR_TITLE',
          severity: 'warning',
          skus: [rows[i].sku, rows[j].sku],
          message: `两条标题高度相似,只差:${diff.join('、') || '(仅数字或停用词)'}。` +
            '确认这个区分维度落在标题前 40 字符内,否则移动端看不到,等于没区分。',
        });
      }
    }
  }

  // ③ 五点整组照搬 —— 不同商品共用同一套五点,多半是复制忘了改
  const bulletKey = new Map();
  for (const r of rows) {
    if (r.bullets.length === 0) continue;
    const key = r.bullets.map(normalizeForPhrase).join('||');
    if (!bulletKey.has(key)) bulletKey.set(key, []);
    bulletKey.get(key).push(r.sku);
  }
  for (const [, skus] of bulletKey) {
    if (skus.length > 1) {
      findings.push({
        code: 'W_DUPLICATE_BULLETS',
        severity: 'warning',
        skus,
        message: `这 ${skus.length} 条的五点完全相同。同款不同颜色/尺寸可以共用大部分内容,` +
          '但至少要有一条体现各自的区分维度。',
      });
    }
  }

  return findings;
}

/**
 * 把逐条的 errors/warnings 按 code 聚合。
 *
 * 动机:5 条草稿就产出 23 条警告,其中 16 条是同一个 W_BELOW_TARGET——
 * 逐条列出来的结果是人直接跳过。20 条批量会输出上百行,等于没有。
 */
export function aggregateFindings(items, key) {
  const groups = new Map();
  for (const item of items) {
    for (const f of item[key] ?? []) {
      if (!groups.has(f.code)) groups.set(f.code, { code: f.code, count: 0, skus: [], sample: f.message });
      const g = groups.get(f.code);
      g.count += 1;
      if (!g.skus.includes(item.sku)) g.skus.push(item.sku);
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

// ───────────────────────────────────────── 对照报告

/** 把错误按 code 汇总成「标题超限×1、五点全大写×5」这种人话。 */
export function summarizeErrors(errors) {
  const label = {
    E_TOO_LONG: '超出上限',
    E_TOO_SHORT: '过短',
    E_BRAND_NOT_FIRST: '标题没以品牌开头',
    E_ALL_CAPS: '全大写',
    E_WORD_REPEAT: '同词超两次',
    E_BANNED_WORD: '违禁词',
    E_BANNED_CHAR: '禁用字符',
    E_THIRD_PARTY_BRAND: '第三方品牌',
    E_TITLE_HIGHLIGHT_OVERLAP: '标题亮点重复',
    E_HIGHLIGHTS_NOT_ELIGIBLE: '亮点不满足展示条件',
    E_MAIN_KEYWORD_MISSING: '主词不在标题里',
    E_INCOMPLETE_SET: '不是完整一套',
    E_TOO_MANY_BULLETS: '五点超过 5 条',
    E_EMPTY_BULLET: '五点有空条目',
  };
  const counts = new Map();
  for (const e of errors) {
    const key = label[e.code] ?? e.code;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([k, n]) => `${k}×${n}`).join('、');
}

function fieldLine(name, before, after, limit) {
  const b = before == null || String(before).trim() === '' ? null : charLength(before);
  const a = after == null || String(after).trim() === '' ? null : charLength(after);
  const beforeText = b === null ? '（空）' : `${b} 字符${limit && b > limit ? ' ⚠超限' : ''}`;
  const afterText = a === null ? '（未改）' : `${a} 字符${limit && a > limit ? ' ⚠超限' : ''}`;
  return `${name}  ${beforeText} → ${afterText}`;
}

/**
 * 逐字段「当前值 → 新值」对照报告。
 *
 * 为什么要有它:SKILL.md 规定汇报必须逐字段摆对照、五点要逐条摆,
 * 但靠自觉会漏——实测就漏过一次(只写了"五点各占一个维度",没摆原文)。
 * 把它做成命令,漏不掉。
 */
export function renderReport(draft) {
  const out = [];
  const site = String(draft.marketplace ?? '').toUpperCase();
  const titleLimit = draft.media ? LIMIT.titleMedia : LIMIT.title;
  out.push(`━━━ ${draft.sku ?? '(无 SKU)'}${site ? `（${site} 站）` : ''} ━━━`, '');

  out.push(fieldLine('标题', draft.currentTitle, draft.title, titleLimit));
  if (draft.currentTitle) out.push(`  当前：${draft.currentTitle}`);
  if (draft.title) out.push(`  新版：${draft.title}`);
  out.push('');

  out.push(fieldLine('商品亮点', draft.currentHighlights, draft.highlights, LIMIT.highlights));
  if (draft.currentHighlights) out.push(`  当前：${draft.currentHighlights}`);
  if (draft.highlights) out.push(`  新版：${draft.highlights}`);
  out.push('');

  const oldB = Array.isArray(draft.currentBullets) ? draft.currentBullets : [];
  const newB = Array.isArray(draft.bullets) ? draft.bullets : [];
  out.push(`五点  ${oldB.length} 条 → ${newB.length} 条`);
  for (let i = 0; i < Math.max(oldB.length, newB.length); i += 1) {
    const o = oldB[i];
    const n = newB[i];
    const oLen = o ? `${charLength(o)}` : '—';
    const nLen = n ? `${charLength(n)}` : '—';
    out.push(`  [${i + 1}] ${oLen} → ${nLen} 字符` +
      (n && charLength(n) > LIMIT.bulletChars ? ' ⚠超政策线' : ''));
    if (o) out.push(`      当前：${o}`);
    if (n) out.push(`      新版：${n}`);
  }
  out.push('');

  // 现状体检:把当前值当草稿跑一遍,这是告诉用户"为什么必须改"的最有力材料
  const currentCheck = checkDraft({
    ...draft,
    title: draft.currentTitle ?? null,
    highlights: draft.currentHighlights ?? null,
    bullets: oldB.length ? oldB : null,
    currentTitle: draft.currentTitle,
    currentHighlights: draft.currentHighlights,
  });
  const newCheck = checkDraft(draft, { requireComplete: true });
  out.push(`现状校验：${currentCheck.ok ? '✅ 通过' : `❌ ${currentCheck.errors.length} 个问题 —— ${summarizeErrors(currentCheck.errors)}`}`);
  out.push(`新版校验：${newCheck.ok ? `✅ 通过，${newCheck.warnings.length} 条警告` : `❌ ${newCheck.errors.length} 个问题 —— ${summarizeErrors(newCheck.errors)}`}`);
  for (const w of newCheck.warnings) out.push(`  ⚠ ${w.field}：${w.message}`);
  out.push('');

  if (draft.currentDescription) {
    out.push(`商品描述  ${charLength(draft.currentDescription)} 字符（本次不改，但已读作素材）`);
    const issues = newCheck.warnings.filter((w) => w.code === 'W_DESCRIPTION_ISSUE');
    out.push(issues.length
      ? `  ⚠ 描述里已存在 ${issues.length} 处问题，会和新文案矛盾，建议一并修`
      : '  ✅ 描述没有明显违规');
    out.push('');
  } else {
    out.push('商品描述  ⚠️ 未提供 —— 它是素材的一部分，漏读会丢事实、也看不出改完后的矛盾');
    out.push('');
  }

  const omitted = draft.omitted ?? [];
  out.push(`未写入的信息：${omitted.length ? '' : '（无）'}`);
  for (const item of omitted) out.push(`  - ${item}`);

  const conflicts = draft.conflicts ?? [];
  out.push(`素材矛盾：${conflicts.length ? '' : '（无）'}`);
  for (const c of conflicts) {
    out.push(`  - ${c.field}：${c.claims} → 采用「${c.chosen}」（${c.reason}）`);
  }

  // 强制项:主词是怎么定的必须说清楚,没有流量依据就要明说
  out.push(draft.keywordEvidence
    ? `选词依据：${draft.keywordEvidence}`
    : '选词依据：⚠️ 未提供 —— 必须说明主词是怎么定的；没有流量数据就明确标注「选词未经流量验证」');
  out.push('');
  out.push('哪个字段想保留原样？告诉我我就把它从写入里去掉。');
  return out.join('\n');
}

export function safeFileName(sku) {
  return String(sku ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
}

// ───────────────────────────────────────── CLI

function parseArgs(argv) {
  // 裸 --help / -h(没带子命令)也要认,否则会掉进"missing --file"
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    return { command: 'help', args: {} };
  }
  const [command, ...rest] = argv;
  const args = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === 'force' || key === 'help' || key === 'complete' || key === 'audit') {
      args[key] = true;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for --${key}`);
    }
    args[key] = value;
    i += 1;
  }
  return { command, args };
}

function loadDrafts(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const drafts = Array.isArray(parsed) ? parsed : [parsed];
  if (drafts.length === 0) throw new Error(`${file} 里没有草稿`);
  return drafts;
}

const HELP = `check-copy —— Amazon 标题/亮点文案的机器校验与 patch 组装

  node check-copy.mjs extract --file <listing 原始返回> --out <草稿骨架.json>
                              [--marketplace DE] [--highlight-attr title_differentiation]
  node check-copy.mjs check   --file <草稿.json> [--complete] [--audit]
  node check-copy.mjs report  --file <草稿.json>
  node check-copy.mjs patches --file <草稿.json> --out-dir <目录> [--account <店铺>] [--complete] [--force]

  extract     吃 listing sku 的 JSON 或 listing batch 的 jsonl,直接吐草稿骨架:
              currentTitle / currentHighlights / currentBullets / currentDescription /
              sourceFacts / attributes / valueTemplate 一次填满,title/highlights/bullets 留空。
              **别再手写提取脚本**——漏字段就是那么来的(实测漏过 product_description)。

  report      逐字段「当前值 → 新值」对照表(五点逐条),外加现状体检和新版校验结果。
              **汇报给用户时一律用它生成**,不要手写——手写会漏(实测漏过五点原文)。
              要它完整,草稿里得有 currentTitle / currentHighlights / currentBullets
              和 keywordEvidence。

  --audit     审"现状"用(把现值当草稿喂进来时加上)。店铺自定规矩(house-rule,
              如禁 emoji)对存量内容降为警告——存量不追,只管新写的。

  --complete  要求每条都是**一整套**新文案(标题+亮点+五点≥3 条),缺哪个报
              E_INCOMPLETE_SET。优化交付一律带上它——三个字段是咬合的,
              只交一部分另外两个必然对不上。

草稿 JSON(单个对象或对象数组):

  {
    "sku": "ABC-123",
    "marketplace": "DE",              // 站点码,用于推断语言
    "productType": "ROTATING_TRAY",   // patches 子命令生成命令行时用
    "language": "德语",                // 可选,不给按 marketplace 推
    "media": false,                   // 可选,媒体类目标题上限 200
    "brand": "Demobrand",             // 标题必须以它开头
    "mainKeyword": "serving tray",    // 可选:唯一主词,须在标题里且落在前 40 字符内
    "title": "新标题",                 // null = 本次不改
    "highlights": "新亮点",
    "bullets": ["...", "..."],        // 五点,最多 5 条
    "searchTerms": "...",             // 可选(默认缓做)
    "currentTitle": "旧标题",          // 不改标题时用于判断亮点前置条件与跨字段重复
    "currentHighlights": "旧亮点",
    "currentDescription": "商品描述原文",  // 必填素材:本次不改它,但要读+审计
    "thirdPartyBrands": ["Sony"],     // 标题/亮点里出现即报错
    "allowCaps": ["ABS"],             // 确属缩写的全大写白名单
    "allowOverlap": ["tray"],         // 确属必要的标题↔亮点重复白名单
    "attributes":   { "title": "item_name", "highlights": "item_highlight",
                      "bullets": "bullet_point" },
    "valueTemplate": { "item_name": { "marketplace_id": "...", "language_tag": "de_DE" } }
  }

attributes / valueTemplate 只有 patches 子命令用,且**必须来自 listing schema
和该 SKU 的当前值**,不要凭记忆填。

输出 JSON 到 stdout。有错误时退出码 1。`;

function main(argv) {
  const { command, args } = parseArgs(argv);
  if (!command || args.help || command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (!args.file) throw new Error('missing --file');

  if (command === 'extract') {
    const raw = readFileSync(args.file, 'utf8');
    // 两种输入:listing sku 的单个 JSON,或 listing batch 的 jsonl(每行一个)
    const rows = [];
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') && !trimmed.includes('\n{')) {
      rows.push(JSON.parse(trimmed.slice(trimmed.indexOf('{'))));
    } else {
      for (const line of raw.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || !t.startsWith('{')) continue;
        try {
          const parsed = JSON.parse(t);
          if (!parsed.journalMeta) rows.push(parsed);
        } catch {
          // 半截写入的行忽略
        }
      }
    }
    const { drafts: extracted, notes } = extractDrafts(rows, {
      ...(args.marketplace ? { marketplace: args.marketplace } : {}),
      ...(args['highlight-attr'] ? { highlightAttr: args['highlight-attr'] } : {}),
    });
    if (args.out) {
      writeFileSync(args.out, `${JSON.stringify(extracted, null, 2)}
`, 'utf8');
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      extracted: extracted.length,
      outFile: args.out ?? null,
      notes,
      next: 'title / highlights / bullets 留空了,那是你要写的。素材字段已一次填满,' +
        '别再手写提取脚本——漏字段就是那么来的。',
      ...(args.out ? {} : { drafts: extracted }),
    }, null, 2)}
`);
    return 0;
  }

  const drafts = loadDrafts(args.file);
  const checkOptions = {
    requireComplete: Boolean(args.complete),
    audit: Boolean(args.audit),
  };
  const items = drafts.map((draft) => checkDraft(draft, checkOptions));
  const failed = items.filter((item) => !item.ok);

  if (command === 'check') {
    const batch = checkBatch(drafts);
    const batchErrors = batch.filter((f) => f.severity === 'error');
    process.stdout.write(`${JSON.stringify({
      ok: failed.length === 0 && batchErrors.length === 0,
      checked: items.length,
      failed: failed.length,
      warnings: items.reduce((sum, item) => sum + item.warnings.length, 0),
      // 聚合在前、明细在后:20 条批量时逐条警告有上百行,先看聚合才抓得住重点
      summary: {
        errors: aggregateFindings(items, 'errors'),
        warnings: aggregateFindings(items, 'warnings'),
      },
      batch,
      items,
    }, null, 2)}\n`);
    return failed.length === 0 && batchErrors.length === 0 ? 0 : 1;
  }

  if (command === 'report') {
    process.stdout.write(`${drafts.map(renderReport).join('\n\n')}\n`);
    return 0; // 报告只负责展示,不做门禁——门禁是 check 的事
  }

  if (command === 'patches') {
    if (!args['out-dir']) throw new Error('missing --out-dir');
    const batchErrors = checkBatch(drafts).filter((f) => f.severity === 'error');
    if (batchErrors.length > 0 && !args.force) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        reason: '整批存在跨条目问题(如多条标题完全相同),拒绝生成 patch。',
        batch: batchErrors,
      }, null, 2)}\n`);
      return 1;
    }
    if (failed.length > 0 && !args.force) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        reason: '有草稿没通过校验,拒绝生成 patch。先修文案再来(确需强制请加 --force)。',
        failed: failed.length,
        items: failed,
      }, null, 2)}\n`);
      return 1;
    }
    const outDir = path.resolve(args['out-dir']);
    mkdirSync(outDir, { recursive: true });
    const used = new Map();
    const index = [];
    const commands = [];
    for (const draft of drafts) {
      const patches = buildPatches(draft);
      let base = safeFileName(draft.sku);
      const seen = used.get(base) ?? 0;
      used.set(base, seen + 1);
      if (seen > 0) base = `${base}-${seen + 1}`;
      const file = path.join(outDir, `${base}.patch.json`);
      writeFileSync(file, `${JSON.stringify(patches, null, 2)}\n`, 'utf8');
      const account = args.account ? ` --account ${args.account}` : '';
      const command2 =
        `amz-cli listing update${account} --marketplace ${draft.marketplace}` +
        ` --sku "${draft.sku}" --product-type ${draft.productType}` +
        ` --patches @${file} --dry-run`;
      index.push({
        sku: draft.sku,
        marketplace: draft.marketplace,
        productType: draft.productType,
        patchFile: file,
        fields: patches.map((p) => p.path.replace('/attributes/', '')),
      });
      commands.push(command2);
    }
    const indexFile = path.join(outDir, 'index.json');
    writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
    const commandFile = path.join(outDir, 'dry-run.txt');
    writeFileSync(commandFile, `${commands.join('\n')}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({
      ok: true,
      count: index.length,
      indexFile,
      commandFile,
      note: 'dry-run.txt 是预览命令。正式写入必须由使用者本人在交互式终端确认,不能自动执行。',
      index,
    }, null, 2)}\n`);
    return 0;
  }

  throw new Error(`unknown command: ${command}`);
}

// 被 import 时不执行 CLI(单测直接调函数)。
// Windows 路径带反斜杠和盘符,必须用 pathToFileURL 归一,不能手拼 file:// 前缀。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
