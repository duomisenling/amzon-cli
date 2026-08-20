#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATUSES = new Set([
  'new',
  'continued',
  'diagnosed',
  'prepared',
  'applied',
  'blocked',
  'reviewing',
  'improved',
  'deferred',
]);
const READY_STATUSES = new Set(['new', 'continued']);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    args[key] = value;
    index += 1;
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

function parseAsins(value, maximum = 100) {
  const asins = [
    ...new Set(value.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean)),
  ];
  if (asins.length < 1 || asins.length > maximum) {
    throw new Error(`--asins must contain 1-${maximum} ASINs`);
  }
  for (const asin of asins) {
    if (!/^[A-Z0-9]{10}$/.test(asin)) throw new Error(`invalid ASIN: ${asin}`);
  }
  return asins;
}

function parseInteger(value, label, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

function validateAsOf(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('--as-of must be YYYY-MM-DD');
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error('--as-of must be a real calendar date');
  }
  return value;
}

async function readRecords(dir) {
  const file = path.join(dir, 'screenings.json');
  try {
    const records = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Array.isArray(records)) throw new Error('state root must be an array');
    return { file, records };
  } catch (error) {
    if (error.code === 'ENOENT') return { file, records: [] };
    throw new Error(`cannot read screening state: ${error.message}`);
  }
}

async function writeRecords(file, records) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.rename(temporary, file);
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function latestPriorItem(records, account, marketplace, asin) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.account !== account || record.marketplace !== marketplace) continue;
    const item = record.items?.find((candidate) => candidate.asin === asin);
    if (item) return item;
  }
  return undefined;
}

function initialStatus(previous) {
  if (!previous) return 'new';
  if (previous.status === 'blocked') return 'blocked';
  if (previous.status === 'applied' || previous.status === 'reviewing') return 'reviewing';
  return 'continued';
}

async function main() {
  const { command, args } = parseArgs(process.argv.slice(2));
  if (!['create', 'next', 'mark', 'show', 'latest'].includes(command)) {
    throw new Error('usage: scan-state.mjs <create|next|mark|show|latest> [options]');
  }

  const dir = stateDir(args);
  const { file, records } = await readRecords(dir);

  if (command === 'create') {
    const scanId = requireText(args, 'scan-id');
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(scanId)) {
      throw new Error('--scan-id must contain only letters, numbers, underscore, or hyphen');
    }
    const account = requireText(args, 'account');
    const marketplace = requireText(args, 'marketplace').toUpperCase();
    const asOf = validateAsOf(requireText(args, 'as-of'));
    const asins = parseAsins(requireText(args, 'asins'));
    const offset = parseInteger(args.offset ?? '0', '--offset', 0, 999_999);
    const totalCandidates = parseInteger(
      requireText(args, 'total-candidates'),
      '--total-candidates',
      offset + asins.length,
      1_000_000,
    );
    const existing = records.find(
      (record) =>
        record.id === scanId &&
        record.account === account &&
        record.marketplace === marketplace,
    );
    if (existing) {
      if (
        existing.account !== account ||
        existing.marketplace !== marketplace ||
        existing.asOf !== asOf
      ) {
        throw new Error(`screening identity mismatch for existing scan: ${scanId}`);
      }
      const known = new Set(existing.items.map((item) => item.asin));
      const updatedAt = new Date().toISOString();
      for (const [index, asin] of asins.entries()) {
        if (known.has(asin)) continue;
        const previous = latestPriorItem(records, account, marketplace, asin);
        existing.items.push({
          asin,
          rank: offset + index + 1,
          status: initialStatus(previous),
          ...(previous ? { previousStatus: previous.status } : {}),
          updatedAt,
        });
      }
      existing.items.sort((a, b) => a.rank - b.rank || a.asin.localeCompare(b.asin));
      existing.totalCandidates = Math.max(existing.totalCandidates, totalCandidates);
      existing.updatedAt = updatedAt;
      await writeRecords(file, records);
      output(existing);
      return;
    }
    const createdAt = new Date().toISOString();
    const record = {
      id: scanId,
      account,
      marketplace,
      asOf,
      totalCandidates,
      createdAt,
      items: asins.map((asin, index) => {
        const previous = latestPriorItem(records, account, marketplace, asin);
        return {
          asin,
          rank: offset + index + 1,
          status: initialStatus(previous),
          ...(previous ? { previousStatus: previous.status } : {}),
          updatedAt: createdAt,
        };
      }),
    };
    records.push(record);
    await writeRecords(file, records);
    output(record);
    return;
  }

  if (command === 'latest') {
    const account = requireText(args, 'account');
    const marketplace = requireText(args, 'marketplace').toUpperCase();
    const record = [...records]
      .reverse()
      .find((candidate) => candidate.account === account && candidate.marketplace === marketplace);
    if (!record) throw new Error(`screening not found for ${account}/${marketplace}`);
    output(record);
    return;
  }

  const scanId = requireText(args, 'scan-id');
  const account = args.account?.trim();
  const marketplace = args.marketplace?.trim().toUpperCase();
  const matches = records.filter(
    (candidate) =>
      candidate.id === scanId &&
      (!account || candidate.account === account) &&
      (!marketplace || candidate.marketplace === marketplace),
  );
  if (matches.length === 0) throw new Error(`screening not found: ${scanId}`);
  if (matches.length > 1) {
    throw new Error(
      `screening ${scanId} exists in multiple stores; provide --account and --marketplace`,
    );
  }
  const record = matches[0];

  if (command === 'show') {
    output(record);
    return;
  }

  if (command === 'next') {
    const limit = parseInteger(args.limit ?? '20', '--limit', 1, 20);
    const items = record.items.filter((item) => READY_STATUSES.has(item.status)).slice(0, limit);
    output({
      scanId: record.id,
      account: record.account,
      marketplace: record.marketplace,
      asOf: record.asOf,
      count: items.length,
      remaining: record.items.filter((item) => READY_STATUSES.has(item.status)).length,
      items,
    });
    return;
  }

  const status = requireText(args, 'status').toLowerCase();
  if (!STATUSES.has(status) || READY_STATUSES.has(status)) {
    throw new Error(
      '--status must be diagnosed, prepared, applied, blocked, reviewing, improved, or deferred',
    );
  }
  const asins = parseAsins(requireText(args, 'asins'), 20);
  const selected = new Set(asins);
  const missing = asins.filter((asin) => !record.items.some((item) => item.asin === asin));
  if (missing.length > 0) throw new Error(`ASINs are not in screening ${scanId}: ${missing.join(',')}`);
  const updatedAt = new Date().toISOString();
  for (const item of record.items) {
    if (!selected.has(item.asin)) continue;
    item.status = status;
    item.updatedAt = updatedAt;
    if (args.note?.trim()) item.note = args.note.trim();
  }
  record.updatedAt = updatedAt;
  await writeRecords(file, records);
  output(record);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
  process.exitCode = 1;
});
