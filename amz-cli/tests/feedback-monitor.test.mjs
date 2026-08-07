import assert from 'node:assert/strict';
import { test } from 'node:test';
import { feedbackRun } from '../dist/shortcuts/feedback/monitor.js';
import { requireReportDocumentId } from '../dist/shortcuts/report/infra.js';

// ---- requireReportDocumentId(报告 DONE 但缺文档 ID 的防护) ----
test('requireReportDocumentId:有 documentId 原样返回', () => {
  assert.equal(
    requireReportDocumentId({ reportId: 'R1', processingStatus: 'DONE', reportDocumentId: 'DOC-1' }),
    'DOC-1',
  );
});

test('requireReportDocumentId:DONE 但缺 documentId 抛类型化上游错误(不再拼出 /documents/undefined)', () => {
  assert.throws(
    () => requireReportDocumentId({ reportId: 'R1', processingStatus: 'DONE' }),
    (e) => e?.subtype === 'report.missing_document_id' && e?.type === 'upstream_error',
  );
});

// ---- feedback run 的报告链路 ----
function contextWith(getResponse) {
  return {
    flags: { marketplace: 'US' },
    progress() {},
    client: {
      async request() {
        return { reportId: 'R1' }; // createReport
      },
      async get() {
        return getResponse; // getReport 轮询
      },
    },
  };
}

test('feedback run:报告 CANCELLED 当作"期间无 1-3 星反馈"的正常结果,不抛错(与 aged/stranded 对齐)', async () => {
  const ctx = contextWith({ reportId: 'R1', processingStatus: 'CANCELLED' });
  const result = await feedbackRun.execute(ctx);
  assert.equal(result.totalRows, 0);
  assert.deepEqual(result.feedback, []);
  assert.match(result.note, /没有 1-3 星反馈/);
});

test('feedback run:报告 DONE 但缺 documentId 时抛 report.missing_document_id', async () => {
  const ctx = contextWith({ reportId: 'R1', processingStatus: 'DONE' });
  await assert.rejects(
    () => feedbackRun.execute(ctx),
    (e) => e?.subtype === 'report.missing_document_id',
  );
});
