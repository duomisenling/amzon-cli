#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// 复盘节奏。default 适用于常规投放；low-volume 适用于月销 0-5 单的长尾品——
// 这类商品累计点击增长极慢，第3天/第14天根本拿不到能下结论的样本，按日历强行判断
// 只会误停还没跑够点击的词。节奏只决定"什么时候回来看"，不代表到期就必须动广告。
const CADENCES = {
  default: [3, 7, 14],
  'low-volume': [7, 30, 90],
};

/** 取记录自己的节点天数；老记录没有 cadence 字段时按已存的 checkpoints 反推。 */
function recordDays(record) {
  return record.checkpoints.map((checkpoint) => checkpoint.day);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = rest[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    args[key] = value;
    i += 1;
  }
  return { command, args };
}

function stateDir(args) {
  if (args['state-dir']) return path.resolve(args['state-dir']);
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'amz-cli', 'ads-reviews');
}

function requireText(args, key) {
  const value = args[key]?.trim();
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function parseDate(value, label) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid ISO date`);
  return date;
}

function parseAsins(value) {
  const asins = [...new Set(value.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean))];
  if (asins.length < 1 || asins.length > 20) throw new Error('--asins must contain 1-20 ASINs');
  for (const asin of asins) {
    if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error(`invalid ASIN: ${asin}`);
  }
  return asins;
}

function addDays(iso, days) {
  const date = parseDate(iso, 'applied-at');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

async function readRecords(dir) {
  const file = path.join(dir, 'reviews.json');
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('state root must be an array');
    return { file, records: parsed };
  } catch (error) {
    if (error.code === 'ENOENT') return { file, records: [] };
    throw new Error(`cannot read review state: ${error.message}`);
  }
}

async function writeRecords(file, records) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, file);
}

function nextPending(record) {
  return record.checkpoints.find((checkpoint) => checkpoint.status === 'pending');
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const { command, args } = parseArgs(process.argv.slice(2));
  if (!['create', 'due', 'show', 'complete'].includes(command)) {
    throw new Error('usage: review-state.mjs <create|due|show|complete> [options]');
  }

  const dir = stateDir(args);
  const { file, records } = await readRecords(dir);

  if (command === 'create') {
    const appliedAt = parseDate(requireText(args, 'applied-at'), '--applied-at').toISOString();
    const cadence = (args.cadence ?? 'default').trim();
    const days = CADENCES[cadence];
    if (!days) throw new Error(`--cadence must be one of: ${Object.keys(CADENCES).join(', ')}`);
    const record = {
      id: `adsrev_${crypto.randomUUID()}`,
      account: requireText(args, 'account'),
      marketplace: requireText(args, 'marketplace').toUpperCase(),
      asins: parseAsins(requireText(args, 'asins')),
      summary: requireText(args, 'summary'),
      status: 'applied',
      cadence,
      appliedAt,
      createdAt: new Date().toISOString(),
      checkpoints: days.map((day) => ({ day, dueAt: addDays(appliedAt, day), status: 'pending' })),
    };
    records.push(record);
    await writeRecords(file, records);
    output(record);
    return;
  }

  if (command === 'due') {
    const now = args.now ? parseDate(args.now, '--now') : new Date();
    const due = records
      .filter((record) => !['completed', 'blocked'].includes(record.status))
      .map((record) => ({ record, checkpoint: nextPending(record) }))
      .filter(({ checkpoint }) => checkpoint && parseDate(checkpoint.dueAt, 'dueAt') <= now)
      .sort((a, b) => a.checkpoint.dueAt.localeCompare(b.checkpoint.dueAt))
      .map(({ record, checkpoint }) => ({
        id: record.id,
        account: record.account,
        marketplace: record.marketplace,
        asins: record.asins,
        cadence: record.cadence ?? 'default',
        day: checkpoint.day,
        dueAt: checkpoint.dueAt,
        summary: record.summary,
      }));
    output(due);
    return;
  }

  const id = requireText(args, 'id');
  const record = records.find((item) => item.id === id);
  if (!record) throw new Error(`review not found: ${id}`);

  if (command === 'show') {
    output(record);
    return;
  }

  const day = Number(requireText(args, 'day'));
  const days = recordDays(record);
  if (!days.includes(day)) throw new Error(`--day must be one of: ${days.join(', ')}`);
  const checkpoint = record.checkpoints.find((item) => item.day === day);
  const expected = nextPending(record);
  if (!expected || expected.day !== day) {
    throw new Error(`checkpoint must be completed in order; expected ${expected?.day ?? 'none'}`);
  }
  checkpoint.status = 'completed';
  checkpoint.completedAt = new Date().toISOString();
  checkpoint.result = requireText(args, 'result');
  record.status = day === days[days.length - 1] ? 'completed' : 'applied';
  record.updatedAt = checkpoint.completedAt;
  await writeRecords(file, records);
  output(record);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
  process.exitCode = 1;
});
