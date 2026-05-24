#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');

const app = express();
const port = Number(process.env.QA_SIGNOFF_PORT || 4310);
const dataDir = path.join(__dirname, 'data');
const dbPath = process.env.QA_SIGNOFF_DB_PATH || path.join(dataDir, 'qa-signoff.db');
const templatePath = process.env.QA_SIGNOFF_TEMPLATE_PATH || path.join(__dirname, '..', 'qa-signoff', 'signoff-template.json');
const adminToken = String(process.env.QA_SIGNOFF_ADMIN_TOKEN || '').trim();

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS qa_signoff_checks (
    module_id TEXT NOT NULL,
    check_id TEXT NOT NULL,
    check_label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    notes TEXT NOT NULL DEFAULT '',
    tested_by TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (module_id, check_id)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS qa_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    module_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    severity TEXT NOT NULL DEFAULT 'medium',
    decision TEXT NOT NULL DEFAULT 'undecided',
    status TEXT NOT NULL DEFAULT 'open',
    owner TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'check';
}

function ensureAuthorized(req, res, next) {
  if (!adminToken) return next();
  const provided = String(req.get('x-admin-token') || req.body?.adminToken || '').trim();
  if (!provided || provided !== adminToken) {
    return res.status(401).json({ success: false, error: { message: 'Unauthorized' } });
  }
  return next();
}

function loadTemplate() {
  const raw = fs.readFileSync(templatePath, 'utf8');
  const parsed = JSON.parse(raw);
  const modules = Array.isArray(parsed.modules) ? parsed.modules : [];
  return {
    version: String(parsed.version || 'v1'),
    updatedAt: String(parsed.updatedAt || ''),
    modules: modules.map((moduleRow) => ({
      moduleId: String(moduleRow.moduleId || ''),
      moduleLabel: String(moduleRow.moduleLabel || moduleRow.moduleId || 'Module'),
      checks: Array.isArray(moduleRow.checks) ? moduleRow.checks.map((checkRow, idx) => {
        if (typeof checkRow === 'string') {
          return {
            checkId: `c_${idx + 1}_${slugify(checkRow).slice(0, 40)}`,
            label: checkRow,
            howToTest: '',
          };
        }
        const label = String(checkRow.label || '').trim();
        const checkId = String(checkRow.checkId || '').trim() || `c_${idx + 1}_${slugify(label).slice(0, 40)}`;
        const howToTest = String(checkRow.howToTest || '').trim();
        return { checkId, label, howToTest };
      }) : []
    }))
  };
}

function buildBoard() {
  const template = loadTemplate();
  const rows = db.prepare('SELECT * FROM qa_signoff_checks').all();
  const map = new Map(rows.map((row) => [`${row.module_id}:${row.check_id}`, row]));

  const modules = template.modules.map((moduleRow) => {
    const checks = moduleRow.checks.map((check) => {
      const current = map.get(`${moduleRow.moduleId}:${check.checkId}`);
      return {
        checkId: check.checkId,
        label: check.label,
        howToTest: check.howToTest || '',
        status: current?.status || 'pending',
        notes: current?.notes || '',
        testedBy: current?.tested_by || '',
        updatedBy: current?.updated_by || '',
        updatedAt: current?.updated_at || null,
      };
    });
    return {
      moduleId: moduleRow.moduleId,
      moduleLabel: moduleRow.moduleLabel,
      checks,
    };
  });

  return {
    version: template.version,
    updatedAt: template.updatedAt,
    modules,
  };
}

function listFindings() {
  return db.prepare('SELECT * FROM qa_findings ORDER BY updated_at DESC, id DESC').all().map((row) => ({
    id: row.id,
    moduleId: row.module_id,
    title: row.title,
    details: row.details,
    severity: row.severity,
    decision: row.decision,
    status: row.status,
    owner: row.owner,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

app.get('/api/health', (_req, res) => {
  res.json({ success: true, data: { ok: true } });
});

app.get('/api/board', (_req, res) => {
  try {
    return res.json({ success: true, data: buildBoard() });
  } catch (error) {
    return res.status(500).json({ success: false, error: { message: error.message || 'Failed to load board' } });
  }
});

app.put('/api/board/check', ensureAuthorized, (req, res) => {
  try {
    const moduleId = String(req.body?.moduleId || '').trim();
    const checkId = String(req.body?.checkId || '').trim();
    const checkLabel = String(req.body?.checkLabel || '').trim();
    const status = String(req.body?.status || '').trim().toLowerCase();
    const notes = String(req.body?.notes || '').slice(0, 4000);
    const testedBy = String(req.body?.testedBy || '').slice(0, 120);
    const updatedBy = String(req.body?.updatedBy || testedBy || '').slice(0, 120);

    if (!moduleId || !checkId || !checkLabel) {
      return res.status(400).json({ success: false, error: { message: 'moduleId, checkId, and checkLabel are required' } });
    }
    if (!['pending', 'pass', 'fail', 'blocked', 'na'].includes(status)) {
      return res.status(400).json({ success: false, error: { message: 'Invalid status' } });
    }

    db.prepare(`
      INSERT INTO qa_signoff_checks (module_id, check_id, check_label, status, notes, tested_by, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(module_id, check_id) DO UPDATE SET
        check_label=excluded.check_label,
        status=excluded.status,
        notes=excluded.notes,
        tested_by=excluded.tested_by,
        updated_by=excluded.updated_by,
        updated_at=datetime('now')
    `).run(moduleId, checkId, checkLabel, status, notes, testedBy, updatedBy);

    return res.json({ success: true, data: { updated: true } });
  } catch (error) {
    return res.status(500).json({ success: false, error: { message: error.message || 'Failed to update check' } });
  }
});

app.get('/api/findings', (_req, res) => {
  try {
    return res.json({ success: true, data: { findings: listFindings() } });
  } catch (error) {
    return res.status(500).json({ success: false, error: { message: error.message || 'Failed to load findings' } });
  }
});

app.post('/api/findings', ensureAuthorized, (req, res) => {
  try {
    const moduleId = String(req.body?.moduleId || '').trim();
    const title = String(req.body?.title || '').trim();
    const details = String(req.body?.details || '').trim().slice(0, 4000);
    const severity = String(req.body?.severity || 'medium').trim().toLowerCase();
    const decision = String(req.body?.decision || 'undecided').trim().toLowerCase();
    const status = String(req.body?.status || 'open').trim().toLowerCase();
    const owner = String(req.body?.owner || '').trim().slice(0, 120);
    const actor = String(req.body?.actor || '').trim().slice(0, 120);

    if (!title) {
      return res.status(400).json({ success: false, error: { message: 'title is required' } });
    }
    if (!['low', 'medium', 'high', 'critical'].includes(severity)) {
      return res.status(400).json({ success: false, error: { message: 'Invalid severity' } });
    }
    if (!['undecided', 'v1', 'roadmap'].includes(decision)) {
      return res.status(400).json({ success: false, error: { message: 'Invalid decision' } });
    }
    if (!['open', 'in_progress', 'done'].includes(status)) {
      return res.status(400).json({ success: false, error: { message: 'Invalid status' } });
    }

    const insert = db.prepare(`
      INSERT INTO qa_findings (module_id, title, details, severity, decision, status, owner, created_by, updated_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(moduleId, title, details, severity, decision, status, owner, actor, actor);

    return res.json({ success: true, data: { id: insert.lastInsertRowid } });
  } catch (error) {
    return res.status(500).json({ success: false, error: { message: error.message || 'Failed to create finding' } });
  }
});

app.put('/api/findings/:id', ensureAuthorized, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, error: { message: 'Invalid id' } });
    }

    const existing = db.prepare('SELECT * FROM qa_findings WHERE id = ?').get(id);
    if (!existing) {
      return res.status(404).json({ success: false, error: { message: 'Finding not found' } });
    }

    const next = {
      module_id: String(req.body?.moduleId ?? existing.module_id).trim(),
      title: String(req.body?.title ?? existing.title).trim(),
      details: String(req.body?.details ?? existing.details).trim().slice(0, 4000),
      severity: String(req.body?.severity ?? existing.severity).trim().toLowerCase(),
      decision: String(req.body?.decision ?? existing.decision).trim().toLowerCase(),
      status: String(req.body?.status ?? existing.status).trim().toLowerCase(),
      owner: String(req.body?.owner ?? existing.owner).trim().slice(0, 120),
      updated_by: String(req.body?.actor || req.body?.updatedBy || '').trim().slice(0, 120),
    };

    if (!next.title) return res.status(400).json({ success: false, error: { message: 'title is required' } });
    if (!['low', 'medium', 'high', 'critical'].includes(next.severity)) return res.status(400).json({ success: false, error: { message: 'Invalid severity' } });
    if (!['undecided', 'v1', 'roadmap'].includes(next.decision)) return res.status(400).json({ success: false, error: { message: 'Invalid decision' } });
    if (!['open', 'in_progress', 'done'].includes(next.status)) return res.status(400).json({ success: false, error: { message: 'Invalid status' } });

    db.prepare(`
      UPDATE qa_findings
      SET module_id = ?, title = ?, details = ?, severity = ?, decision = ?, status = ?, owner = ?, updated_by = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(next.module_id, next.title, next.details, next.severity, next.decision, next.status, next.owner, next.updated_by, id);

    return res.json({ success: true, data: { updated: true } });
  } catch (error) {
    return res.status(500).json({ success: false, error: { message: error.message || 'Failed to update finding' } });
  }
});

app.get('/api/findings/report', (_req, res) => {
  try {
    const findings = listFindings();
    const grouped = {
      v1: findings.filter((row) => row.decision === 'v1'),
      roadmap: findings.filter((row) => row.decision === 'roadmap'),
      undecided: findings.filter((row) => row.decision === 'undecided'),
    };
    const lines = [];
    lines.push(`# QA Findings Report`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');

    const emitSection = (title, rows) => {
      lines.push(`## ${title} (${rows.length})`);
      if (!rows.length) {
        lines.push('- None');
        lines.push('');
        return;
      }
      rows.forEach((row) => {
        lines.push(`- [${row.severity.toUpperCase()}] ${row.title} (${row.moduleId || 'unscoped'})`);
        if (row.details) lines.push(`  - ${row.details}`);
        lines.push(`  - Status: ${row.status} | Owner: ${row.owner || '-'} | Updated: ${row.updatedAt || '-'}`);
      });
      lines.push('');
    };

    emitSection('Implement for V1', grouped.v1);
    emitSection('Move to Roadmap', grouped.roadmap);
    emitSection('Undecided', grouped.undecided);

    return res.json({
      success: true,
      data: {
        counts: {
          v1: grouped.v1.length,
          roadmap: grouped.roadmap.length,
          undecided: grouped.undecided.length,
          total: findings.length,
        },
        markdown: lines.join('\n'),
        findings,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: { message: error.message || 'Failed to generate findings report' } });
  }
});

app.get('/api/export', (_req, res) => {
  try {
    const payload = {
      exportedAt: new Date().toISOString(),
      board: buildBoard(),
      findings: listFindings(),
    };
    return res.json({ success: true, data: payload });
  } catch (error) {
    return res.status(500).json({ success: false, error: { message: error.message || 'Failed to export' } });
  }
});

app.listen(port, () => {
  console.log(`[qa-signoff-collab] listening on http://localhost:${port}`);
  console.log(`[qa-signoff-collab] db: ${dbPath}`);
  console.log(`[qa-signoff-collab] template: ${templatePath}`);
  if (adminToken) {
    console.log('[qa-signoff-collab] write protection enabled via QA_SIGNOFF_ADMIN_TOKEN');
  }
});
