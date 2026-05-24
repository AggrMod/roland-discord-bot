const statusEl = document.getElementById('statusText');
const modulesWrap = document.getElementById('modulesWrap');
const summaryEl = document.getElementById('summary');
const findingsWrap = document.getElementById('findingsWrap');
const testerInput = document.getElementById('testerName');
const tokenInput = document.getElementById('adminToken');

let board = { modules: [] };
let findings = [];

const STATUS_OPTIONS = ['pending', 'pass', 'fail', 'blocked', 'na'];

function esc(v) {
  return String(v || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function cls(status) { return `st-${String(status || 'pending').toLowerCase()}`; }

function summarize(modules) {
  const out = { total: 0, pending: 0, pass: 0, fail: 0, blocked: 0, na: 0 };
  for (const moduleRow of modules || []) {
    for (const check of moduleRow.checks || []) {
      out.total += 1;
      const key = String(check.status || 'pending').toLowerCase();
      if (Object.prototype.hasOwnProperty.call(out, key)) out[key] += 1;
      else out.pending += 1;
    }
  }
  return out;
}

function renderSummary() {
  const s = summarize(board.modules || []);
  summaryEl.innerHTML = [
    `Total ${s.total}`,
    `Pass ${s.pass}`,
    `Fail ${s.fail}`,
    `Blocked ${s.blocked}`,
    `Pending ${s.pending}`,
    `N/A ${s.na}`,
  ].map((label) => `<span class="pill">${esc(label)}</span>`).join('');
}

function renderFindings() {
  if (!Array.isArray(findings) || findings.length === 0) {
    findingsWrap.innerHTML = '<p class="meta">No findings yet.</p>';
    return;
  }
  findingsWrap.innerHTML = findings.map((f) => `
    <div class="finding">
      <h4>[${esc(String(f.severity || '').toUpperCase())}] ${esc(f.title)} <span class="meta">(${esc(f.moduleId || 'unscoped')})</span></h4>
      <div class="meta">Decision: <strong>${esc(f.decision)}</strong> | Status: <strong>${esc(f.status)}</strong> | Owner: ${esc(f.owner || '-')}</div>
      <div>${esc(f.details || '')}</div>
      <div class="meta">Updated: ${esc(f.updatedAt || '-')} by ${esc(f.updatedBy || '-')}</div>
    </div>
  `).join('');
}

function renderModules() {
  modulesWrap.innerHTML = (board.modules || []).map((moduleRow, mi) => {
    const done = (moduleRow.checks || []).filter((check) => ['pass', 'fail', 'blocked', 'na'].includes(String(check.status || '').toLowerCase())).length;
    const total = (moduleRow.checks || []).length;

    const rows = (moduleRow.checks || []).map((check, ci) => {
      const status = String(check.status || 'pending').toLowerCase();
      const options = STATUS_OPTIONS.map((opt) => `<option value="${opt}" ${opt === status ? 'selected' : ''}>${opt.toUpperCase()}</option>`).join('');
      const guidance = String(check.howToTest || '').trim();
      const guidanceHtml = guidance
        ? `<div class="meta" title="${esc(guidance)}"><strong>How to test:</strong> ${esc(guidance)}</div>`
        : '<div class="meta"><strong>How to test:</strong> Configure the setting, execute the user flow, and verify expected Discord/API result.</div>';
      return `
        <tr>
          <td><strong>${esc(check.label)}</strong>${guidanceHtml}</td>
          <td><span class="${cls(status)}">${esc(status.toUpperCase())}</span></td>
          <td><select data-mi="${mi}" data-ci="${ci}" data-field="status">${options}</select></td>
          <td><input data-mi="${mi}" data-ci="${ci}" data-field="testedBy" value="${esc(check.testedBy || '')}" placeholder="Tester" /></td>
          <td><textarea data-mi="${mi}" data-ci="${ci}" data-field="notes" placeholder="Notes / evidence">${esc(check.notes || '')}</textarea></td>
          <td>
            <button data-mi="${mi}" data-ci="${ci}" data-action="save">Save</button>
            <div class="meta">${esc(check.updatedAt || '-')}</div>
          </td>
        </tr>
      `;
    }).join('');

    return `
      <article class="module">
        <div class="module-head">
          <h2 class="module-title">${esc(moduleRow.moduleLabel)}</h2>
          <div class="meta">${done}/${total} completed</div>
        </div>
        <table>
          <thead>
            <tr><th>Check</th><th>Current</th><th>Set</th><th>Tester</th><th>Notes</th><th>Action</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </article>
    `;
  }).join('');

  renderSummary();
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = String(tokenInput.value || '').trim();
  if (token) headers.set('x-admin-token', token);
  const response = await fetch(path, { ...options, headers });
  const json = await response.json();
  if (!response.ok || json.success === false) {
    throw new Error(json?.error?.message || json?.message || `HTTP ${response.status}`);
  }
  return json.data;
}

async function refreshBoard() {
  statusEl.textContent = 'Loading board...';
  try {
    const [boardData, findingsData] = await Promise.all([
      api('/api/board'),
      api('/api/findings'),
    ]);
    board = boardData;
    findings = findingsData.findings || [];
    renderModules();
    renderFindings();
    statusEl.textContent = `Loaded ${board.modules.length} module groups and ${findings.length} findings.`;
  } catch (error) {
    statusEl.textContent = `Failed to load board: ${error.message}`;
  }
}

function fieldValue(mi, ci, field) {
  const selector = `[data-mi="${mi}"][data-ci="${ci}"][data-field="${field}"]`;
  const el = document.querySelector(selector);
  return el ? el.value : '';
}

async function saveCheck(mi, ci) {
  const moduleRow = board.modules?.[mi];
  const check = moduleRow?.checks?.[ci];
  if (!moduleRow || !check) return;

  const payload = {
    moduleId: moduleRow.moduleId,
    checkId: check.checkId,
    checkLabel: check.label,
    status: String(fieldValue(mi, ci, 'status') || 'pending').toLowerCase(),
    testedBy: String(fieldValue(mi, ci, 'testedBy') || '').trim() || String(testerInput.value || '').trim(),
    updatedBy: String(testerInput.value || '').trim(),
    notes: String(fieldValue(mi, ci, 'notes') || '').trim(),
  };

  try {
    statusEl.textContent = `Saving ${moduleRow.moduleLabel}...`;
    await api('/api/board/check', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    await refreshBoard();
  } catch (error) {
    statusEl.textContent = `Failed to save: ${error.message}`;
  }
}

async function addFinding() {
  const payload = {
    moduleId: String(document.getElementById('findingModuleId').value || '').trim(),
    title: String(document.getElementById('findingTitle').value || '').trim(),
    details: String(document.getElementById('findingDetails').value || '').trim(),
    severity: String(document.getElementById('findingSeverity').value || 'medium').trim().toLowerCase(),
    decision: String(document.getElementById('findingDecision').value || 'undecided').trim().toLowerCase(),
    status: String(document.getElementById('findingStatus').value || 'open').trim().toLowerCase(),
    owner: String(document.getElementById('findingOwner').value || '').trim(),
    actor: String(testerInput.value || '').trim(),
  };

  try {
    await api('/api/findings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    document.getElementById('findingTitle').value = '';
    document.getElementById('findingDetails').value = '';
    await refreshBoard();
    statusEl.textContent = 'Finding added.';
  } catch (error) {
    statusEl.textContent = `Failed to add finding: ${error.message}`;
  }
}

async function downloadReport() {
  try {
    const data = await api('/api/findings/report');
    const blob = new Blob([data.markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `qa-findings-report-${new Date().toISOString().replaceAll(':', '-')}.md`;
    a.click();
    URL.revokeObjectURL(url);
    statusEl.textContent = `Findings report generated: ${data.counts.total} total findings.`;
  } catch (error) {
    statusEl.textContent = `Failed to generate findings report: ${error.message}`;
  }
}

document.getElementById('refreshBtn').addEventListener('click', refreshBoard);
document.getElementById('addFindingBtn').addEventListener('click', addFinding);
document.getElementById('reportBtn').addEventListener('click', downloadReport);
document.getElementById('exportBtn').addEventListener('click', async () => {
  try {
    const data = await api('/api/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `qa-signoff-export-${new Date().toISOString().replaceAll(':', '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
    statusEl.textContent = 'Export downloaded.';
  } catch (error) {
    statusEl.textContent = `Export failed: ${error.message}`;
  }
});

document.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-action="save"]');
  if (!btn) return;
  const mi = Number(btn.dataset.mi);
  const ci = Number(btn.dataset.ci);
  if (!Number.isInteger(mi) || !Number.isInteger(ci)) return;
  saveCheck(mi, ci);
});

refreshBoard();
