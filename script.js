import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc,
  getDoc, onSnapshot, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCYV1L50m1ToBY8PvCgXd2UKG_ZbJkScjQ",
  authDomain: "auditform-e1c43.firebaseapp.com",
  projectId: "auditform-e1c43",
  storageBucket: "auditform-e1c43.firebasestorage.app",
  messagingSenderId: "991041543186",
  appId: "1:991041543186:web:ad0266b141b0768e814ccb"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auditsCol = collection(db, "audits");

const blankRow = () => ({ category: '', parameter: '', constraint: '', remark: '' });

// Category -> list of {parameter, description, constraints[]}.
// Parameter options narrow based on the chosen Category; Constraint options narrow
// based on the chosen Parameter. Where no constraint list was provided (Safe and
// Secure), Constraint falls back to a free-text field for that category.
const AUDIT_TAXONOMY = {
  'Reliable': [
    {
      parameter: 'Irrelevant Solution',
      description: "The resolution should be tailored to the customer's needs and preferences. It should address the specific issue raised by the customer and provide information or assistance that is directly applicable to their situation.",
      constraints: ['No Opportunity', 'Did not understand the intent', 'Did not use the tool appropriately', 'Incorrect Information/Solution provided', 'Incorrect ticket creation', 'Incorrect workgroup/staging', 'Unnecessary endorsement']
    },
    {
      parameter: 'Incomplete Solution',
      description: "The resolution should fully address the customer's concern and provide a comprehensive solution. It should not leave any important questions unanswered or require the customer to seek further assistance for the same issue.",
      constraints: ['No Opportunity', 'Incomplete Information/Solution', 'Incomplete ticket components']
    },
    {
      parameter: 'Untimely Solution (ZTP)',
      description: 'The resolution should be provided in a timely manner, without unnecessary delays. Customers expect prompt responses to their inquiries and timely resolution of their issues to minimize inconvenience and frustration.',
      constraints: ['No Opportunity', 'Delayed ticket creation/staging', 'No ticket created']
    },
    {
      parameter: 'Unclear Solution',
      description: '',
      constraints: ['Sounded unconfident', 'Vague explanation', 'Did not involve the customer in an engaging experience']
    }
  ],
  'Personable': [
    {
      parameter: "Were there other agent factors observed that affected the customer's experience?",
      description: '',
      constraints: ['Poor Listening Skills', 'Customer Validation and Empathy Gap', 'Did not adjust the tone/pace to match the customer', "Did not adjust to the customer's language", 'Negative Words, Phrasing and Limitations', 'Unfriendly/discourteous/sarcastic', 'Sounded transactional or robotic']
    }
  ],
  'Safe and Secure': [
    {
      parameter: 'Did we follow the customer authentication process?',
      description: '',
      constraints: ['No Authentication', 'Unnecessary authentication', 'Did not decline for failed authentication', 'Incorrect/Untimely authentication', 'Incomplete authentication']
    },
    {
      parameter: 'Did we follow the data privacy policy?',
      description: '',
      constraints: ['Divulging Customer Information', 'Divulging internal company processes', 'Divulging internal personnel contacts/information', 'Did not deliver the Outbound Call Monitoring Spiel']
    },
    {
      parameter: 'Did we update the customer information in the tool?',
      description: '',
      constraints: ['Failed to update primary contact information', 'Failed to update secondary contact information']
    },
    {
      parameter: 'Did we follow the CSAT/NPS process?',
      description: '',
      constraints: ['Did not ask for the mobile number', 'Did not update the mobile number field', 'Did not follow the prescribed spiel', 'Did not offer CSAT (For non-Medallia LOBs)']
    },
    {
      parameter: 'Did we follow the system documentation process?',
      description: '',
      constraints: ['Did not document the interaction', 'Incorrect documentation', 'Incomplete documentation', 'Incomplete & Incorrect documentation']
    },
    {
      parameter: 'Did we follow the system tagging process?',
      description: 'Ensure correct & complete tagging in all applicable tools such as ESA, Salesforce, Premiere Daily Tracker, etc.',
      constraints: ['No Tagging', 'Incorrect tagging', 'Incomplete tagging', 'Incomplete & Incorrect tagging']
    },
    {
      parameter: 'Did we follow correct grammar, technical writing & the prescribed language?',
      description: '',
      constraints: ['Incorrect punctuation', 'Incorrect spelling', 'Incorrect capitalization', 'Grammar errors', 'Did not follow the prescribed language']
    },
    {
      parameter: 'Did the agent offer self-care help to the customer?',
      description: '',
      constraints: ['Did not offer Self Care Channel', 'Incomplete Self Care Channel', 'Irrelevant Self Care Channel']
    },
    {
      parameter: 'Did the agent upsell or cross-sell relevant products & services?',
      description: '',
      constraints: ['Did not offer upsell/cross sell', 'Irrelevant/Unnecessary product offered', 'Incomplete information']
    }
  ]
};

function paramEntriesFor(category) {
  return AUDIT_TAXONOMY[category] || [];
}

function constraintsFor(category, parameter) {
  const match = paramEntriesFor(category).find(e => e.parameter === parameter);
  return match ? match.constraints : [];
}

function descriptionFor(category, parameter) {
  const match = paramEntriesFor(category).find(e => e.parameter === parameter);
  return match ? match.description : '';
}

function optionsHtml(options, selected, placeholder) {
  let html = `<option value="" ${selected ? '' : 'selected'}>${escapeHtml(placeholder)}</option>`;
  options.forEach(opt => {
    html += `<option value="${escapeHtml(opt)}" ${opt === selected ? 'selected' : ''}>${escapeHtml(opt)}</option>`;
  });
  return html;
}

let rows = [blankRow()];
let currentAuditId = null;
let latestDocs = []; // last snapshot from Firestore, kept for client-side search filtering

const DRAFT_KEY = 'auditDraftV1';
const LAST_PEOPLE_KEY = 'auditLastPeopleV1'; // remembers last-used team leader
const EVALUATOR_KEY = 'lockedEvaluatorNameV1'; // the evaluator's own name, set once and locked

let ROSTER = {}; // WIN ID -> { agentName, teamLeader }, loaded from roster.json
fetch('roster.json')
  .then(r => r.ok ? r.json() : Promise.reject(new Error('roster.json not found')))
  .then(data => { ROSTER = data; })
  .catch(err => console.error('Could not load roster.json — WIN ID auto-fill will be unavailable.', err));

const rowsContainer = document.getElementById('rowsContainer');
const report = document.getElementById('report');
const savedListEl = document.getElementById('savedList');
const statusMsg = document.getElementById('statusMsg');
const searchInput = document.getElementById('searchAudits');

// hdrAgent/hdrTL were removed — agentName and teamLeader are now the single source
// of truth for both the greeting and the detail table, so nothing has to be typed twice.
const headerFields = ['hdrWin', 'winId', 'ani', 'agentName', 'caseId', 'teamLeader', 'interactionDate', 'evaluator', 'evalDate'];

function saveDraft() {
  try {
    const draft = collectFormData();
    draft.currentAuditId = currentAuditId;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch (e) {
    console.error('Could not save draft', e);
  }
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error('Could not read draft', e);
    return null;
  }
}

function rememberPeople() {
  try {
    localStorage.setItem(LAST_PEOPLE_KEY, JSON.stringify({ teamLeader: val('teamLeader') }));
  } catch (e) { /* ignore */ }
}

function recallPeople() {
  try {
    const raw = localStorage.getItem(LAST_PEOPLE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

/* ---------------- Evaluator name lock ---------------- */

const evaluatorInput = document.getElementById('evaluator');
const evaluatorLockBtn = document.getElementById('evaluatorLockBtn');

function applyEvaluatorLockState() {
  const saved = localStorage.getItem(EVALUATOR_KEY);
  if (saved) {
    evaluatorInput.value = saved;
    evaluatorInput.readOnly = true;
    evaluatorLockBtn.textContent = 'Edit';
  } else {
    evaluatorInput.readOnly = false;
    evaluatorLockBtn.textContent = 'Lock';
  }
}

evaluatorLockBtn.addEventListener('click', () => {
  if (evaluatorInput.readOnly) {
    // Unlock for editing.
    evaluatorInput.readOnly = false;
    evaluatorLockBtn.textContent = 'Lock';
    evaluatorInput.focus();
  } else {
    // Lock in whatever's typed.
    const name = evaluatorInput.value.trim();
    if (!name) {
      setStatus('Type your name before locking it', 'err');
      return;
    }
    localStorage.setItem(EVALUATOR_KEY, name);
    evaluatorInput.readOnly = true;
    evaluatorLockBtn.textContent = 'Edit';
    setStatus('Evaluator name locked', 'ok');
    render();
    saveDraft();
  }
});

headerFields.forEach(id => document.getElementById(id).addEventListener('input', () => { render(); saveDraft(); }));

// Typing a WIN ID and clicking/tabbing away auto-fills Agent name & Team leader from the roster.
document.getElementById('winId').addEventListener('blur', () => {
  const id = val('winId').trim();
  if (!id) return;
  const entry = ROSTER[id];
  if (entry) {
    document.getElementById('agentName').value = entry.agentName || '';
    document.getElementById('teamLeader').value = entry.teamLeader || '';
    render();
    saveDraft();
    setStatus('Agent & team leader auto-filled from roster', 'ok');
  } else {
    setStatus('WIN ID not found in roster — enter agent details manually', 'err');
  }
});

// Enter moves to the next field instead of doing nothing, so a full row of details
// can be filled in without reaching for the mouse or hitting Tab repeatedly.
document.querySelectorAll('.field-grid input').forEach((el, idx, all) => {
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const next = all[idx + 1];
      if (next) next.focus(); else el.blur();
    }
  });
});

function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setStatus(msg, kind) {
  statusMsg.textContent = msg;
  statusMsg.className = 'status' + (kind ? ' ' + kind : '');
  if (msg) {
    setTimeout(() => { if (statusMsg.textContent === msg) statusMsg.textContent = ''; }, 3500);
  }
}

function val(id) { return document.getElementById(id).value; }

function collectFormData() {
  const data = {};
  headerFields.forEach(id => data[id] = document.getElementById(id).value);
  data.rows = rows;
  return data;
}

function applyFormData(data) {
  headerFields.forEach(id => {
    if (id === 'evaluator') return; // evaluator stays locked to the current user, independent of loaded data
    document.getElementById(id).value = (id in data) ? (data[id] || '') : '';
  });
  rows = Array.isArray(data.rows) && data.rows.length ? JSON.parse(JSON.stringify(data.rows)) : [blankRow()];
  renderRowEditors();
  render();
}

function renderRowEditors() {
  rowsContainer.innerHTML = '';
  rows.forEach((row, i) => {
    const item = document.createElement('div');
    item.className = 'row-item';

    const paramEntries = paramEntriesFor(row.category);
    const paramOptions = paramEntries.map(e => e.parameter);
    const constraintOptions = constraintsFor(row.category, row.parameter);

    const constraintFieldHtml = constraintOptions.length
      ? `<select data-idx="${i}" data-key="constraint" class="row-select">${optionsHtml(constraintOptions, row.constraint, '-- Select constraint --')}</select>`
      : `<input data-idx="${i}" data-key="constraint" value="${escapeHtml(row.constraint)}" placeholder="Describe the constraint">`;

    item.innerHTML = `
      <div class="row-actions">
        <span>Finding ${i + 1}</span>
        <button class="btn btn-danger" type="button" data-remove="${i}">Remove</button>
      </div>
      <div class="field-grid">
        <div class="field">
          <label>Category</label>
          <select data-idx="${i}" data-key="category" class="row-select">${optionsHtml(Object.keys(AUDIT_TAXONOMY), row.category, '-- Select category --')}</select>
        </div>
        <div class="field">
          <label>Parameter</label>
          <select data-idx="${i}" data-key="parameter" class="row-select" ${row.category ? '' : 'disabled'}>${optionsHtml(paramOptions, row.parameter, '-- Select parameter --')}</select>
        </div>
        <div class="field"><label>Constraint</label>${constraintFieldHtml}</div>
      </div>
      <div class="field" style="margin-top:8px;">
        <label>Remark / narrative</label>
        <textarea data-idx="${i}" data-key="remark" style="min-height:80px;">${escapeHtml(row.remark)}</textarea>
      </div>
    `;
    rowsContainer.appendChild(item);
  });

  rowsContainer.querySelectorAll('select[data-key="category"]').forEach(el => {
    el.addEventListener('change', e => {
      const idx = e.target.getAttribute('data-idx');
      rows[idx].category = e.target.value;
      rows[idx].parameter = '';
      rows[idx].constraint = '';
      renderRowEditors();
      render();
      saveDraft();
    });
  });

  rowsContainer.querySelectorAll('select[data-key="parameter"]').forEach(el => {
    el.addEventListener('change', e => {
      const idx = e.target.getAttribute('data-idx');
      rows[idx].parameter = e.target.value;
      rows[idx].constraint = '';
      renderRowEditors();
      render();
      saveDraft();
    });
  });

  rowsContainer.querySelectorAll('[data-key="constraint"]').forEach(el => {
    const eventName = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(eventName, e => {
      const idx = e.target.getAttribute('data-idx');
      rows[idx].constraint = e.target.value;
      render();
      saveDraft();
    });
  });

  rowsContainer.querySelectorAll('[data-key="remark"]').forEach(el => {
    el.addEventListener('input', e => {
      const idx = e.target.getAttribute('data-idx');
      rows[idx].remark = e.target.value;
      render();
      saveDraft();
    });
  });

  rowsContainer.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', e => {
      const idx = parseInt(e.target.getAttribute('data-remove'));
      rows.splice(idx, 1);
      renderRowEditors();
      render();
      saveDraft();
    });
  });
}

document.getElementById('addRowBtn').addEventListener('click', () => {
  rows.push(blankRow());
  renderRowEditors();
  render();
  saveDraft();
});

document.getElementById('newBtn').addEventListener('click', () => {
  currentAuditId = null;
  const remembered = recallPeople() || {};
  applyFormData({
    hdrWin: '', winId: '', ani: '', agentName: '', caseId: '',
    teamLeader: remembered.teamLeader || '',
    interactionDate: '',
    evalDate: '',
    rows: [blankRow()]
  });
  saveDraft();
  setStatus(remembered.teamLeader ? 'Started a blank audit (team leader carried over)' : 'Started a blank audit', 'ok');
});

document.getElementById('duplicateCurrentBtn').addEventListener('click', () => {
  currentAuditId = null; // next save creates a new document instead of overwriting
  saveDraft();
  setStatus('Duplicated — edit the details, then Save creates a new audit', 'ok');
});

document.getElementById('printBtn').addEventListener('click', () => window.print());

document.getElementById('copyBtn').addEventListener('click', async () => {
  render(); // make sure preview reflects the latest edits before copying
  const htmlContent = buildInlineStyledReport();
  const textContent = report.innerText;

  try {
    if (window.ClipboardItem) {
      const item = new ClipboardItem({
        'text/html': new Blob([htmlContent], { type: 'text/html' }),
        'text/plain': new Blob([textContent], { type: 'text/plain' })
      });
      await navigator.clipboard.write([item]);
    } else {
      await navigator.clipboard.writeText(textContent);
    }
    setStatus('Copied — paste it into an email or chat', 'ok');
  } catch (e) {
    console.error(e);
    try {
      await navigator.clipboard.writeText(textContent);
      setStatus('Copied as plain text', 'ok');
    } catch (e2) {
      setStatus('Could not copy — try selecting the preview manually', 'err');
    }
  }
});

// Paste targets (Gmail, Outlook, Slack, Teams, Word, Google Docs) don't load our stylesheet,
// and several of them also ignore CSS-only borders/backgrounds on tables unless the same
// thing is also set as an old HTML attribute (border=, bgcolor=). We set both so the
// formatting survives across the widest range of paste destinations.
function buildInlineStyledReport() {
  const cellStyle = 'border:1px solid #8c8c8c;padding:8px 10px;vertical-align:top;font-size:13px;font-family:Calibri,Arial,sans-serif;';
  const greenCellStyle = cellStyle + 'background-color:#c6e0b4;font-weight:700;';
  const yellowHeaderStyle = cellStyle + 'background-color:#ffe699;font-weight:700;text-align:center;';
  const boldCellStyle = cellStyle + 'font-weight:700;';
  const tableAttrs = 'border="1" cellpadding="8" cellspacing="0" bordercolor="#8c8c8c"';
  const tableStyle = 'border-collapse:collapse;border:1px solid #8c8c8c;width:100%;margin-top:14px;';
  const pStyle = 'margin:0 0 10px;line-height:1.5;font-family:Calibri,Arial,sans-serif;font-size:13.5px;color:#000;';

  const bodyRows = rows.map(r => `
    <tr>
      <td ${tableAttrs} style="${boldCellStyle}">${escapeHtml(r.category)}</td>
      <td ${tableAttrs} style="${cellStyle}">${escapeHtml(r.parameter)}</td>
      <td ${tableAttrs} style="${cellStyle}">${escapeHtml(r.constraint)}</td>
      <td ${tableAttrs} style="${cellStyle}">${escapeHtml(r.remark)}</td>
    </tr>
  `).join('');

  return `
    <p style="${pStyle}">Hi @${escapeHtml(val('agentName'))},</p>
    <p style="${pStyle}">Please see below your audit ${escapeHtml(val('hdrWin'))}. We encourage you to review the areas of opportunity highlighted, as these will support continuous improvement. Your acknowledgment will be sincerely appreciated.</p>
    <p style="${pStyle}">Hi TL @${escapeHtml(val('teamLeader'))},</p>
    <p style="${pStyle}">Kindly help us coach the agent immediately to avoid the recurrence of the observed opportunity.</p>

    <table ${tableAttrs} style="${tableStyle}">
      <tbody>
        <tr>
          <td ${tableAttrs} bgcolor="#c6e0b4" style="${greenCellStyle}">WIN ID</td>
          <td ${tableAttrs} style="${cellStyle}">${escapeHtml(val('winId'))}</td>
          <td ${tableAttrs} bgcolor="#c6e0b4" style="${greenCellStyle}">ANI/MIN</td>
          <td ${tableAttrs} style="${boldCellStyle}">${escapeHtml(val('ani'))}</td>
        </tr>
        <tr>
          <td ${tableAttrs} bgcolor="#c6e0b4" style="${greenCellStyle}">Agent name</td>
          <td ${tableAttrs} style="${cellStyle}">${escapeHtml(val('agentName'))}</td>
          <td ${tableAttrs} bgcolor="#c6e0b4" style="${greenCellStyle}">Call/case ID</td>
          <td ${tableAttrs} style="${cellStyle}">${escapeHtml(val('caseId'))}</td>
        </tr>
        <tr>
          <td ${tableAttrs} bgcolor="#c6e0b4" style="${greenCellStyle}">Team leader</td>
          <td ${tableAttrs} style="${cellStyle}">${escapeHtml(val('teamLeader'))}</td>
          <td ${tableAttrs} bgcolor="#c6e0b4" style="${greenCellStyle}">Date and time of interaction</td>
          <td ${tableAttrs} style="${cellStyle}">${escapeHtml(val('interactionDate'))}</td>
        </tr>
        <tr>
          <td ${tableAttrs} bgcolor="#c6e0b4" style="${greenCellStyle}">Evaluator's name</td>
          <td ${tableAttrs} style="${cellStyle}">${escapeHtml(val('evaluator'))}</td>
          <td ${tableAttrs} bgcolor="#c6e0b4" style="${greenCellStyle}">Evaluation date</td>
          <td ${tableAttrs} style="${cellStyle}">${escapeHtml(val('evalDate'))}</td>
        </tr>
      </tbody>
    </table>

    <table ${tableAttrs} style="${tableStyle}">
      <thead>
        <tr>
          <th ${tableAttrs} bgcolor="#ffe699" style="${yellowHeaderStyle}">Category</th>
          <th ${tableAttrs} bgcolor="#ffe699" style="${yellowHeaderStyle}">Parameter</th>
          <th ${tableAttrs} bgcolor="#ffe699" style="${yellowHeaderStyle}">Constraint</th>
          <th ${tableAttrs} bgcolor="#ffe699" style="${yellowHeaderStyle}">Remark</th>
        </tr>
      </thead>
      <tbody>
        ${bodyRows}
      </tbody>
    </table>
  `;
}

function render() {
  const bodyRows = rows.map((r, i) => `
    <tr>
      <td class="editable-cell" contenteditable="true" data-idx="${i}" data-key="category">${escapeHtml(r.category)}</td>
      <td class="editable-cell" contenteditable="true" data-idx="${i}" data-key="parameter">${escapeHtml(r.parameter)}</td>
      <td class="editable-cell" contenteditable="true" data-idx="${i}" data-key="constraint">${escapeHtml(r.constraint)}</td>
      <td class="editable-cell" contenteditable="true" data-idx="${i}" data-key="remark">${escapeHtml(r.remark)}</td>
    </tr>
  `).join('');

  report.innerHTML = `
    <p>Hi @${escapeHtml(val('agentName'))},</p>
    <p>Please see below your audit ${escapeHtml(val('hdrWin'))}. We encourage you to review the areas of opportunity highlighted, as these will support continuous improvement. Your acknowledgment will be sincerely appreciated.</p>
    <p>Hi TL @${escapeHtml(val('teamLeader'))},</p>
    <p>Kindly help us coach the agent immediately to avoid the recurrence of the observed opportunity.</p>

    <table class="audit meta" style="margin-top:14px;">
      <tbody>
        <tr><td>WIN ID</td><td class="editable-cell" contenteditable="true" data-field="winId">${escapeHtml(val('winId'))}</td><td>ANI/MIN</td><td class="editable-cell" contenteditable="true" data-field="ani" style="font-weight:700;">${escapeHtml(val('ani'))}</td></tr>
        <tr><td>Agent name</td><td class="editable-cell" contenteditable="true" data-field="agentName">${escapeHtml(val('agentName'))}</td><td>Call/case ID</td><td class="editable-cell" contenteditable="true" data-field="caseId">${escapeHtml(val('caseId'))}</td></tr>
        <tr><td>Team leader</td><td class="editable-cell" contenteditable="true" data-field="teamLeader">${escapeHtml(val('teamLeader'))}</td><td>Date and time of interaction</td><td class="editable-cell" contenteditable="true" data-field="interactionDate">${escapeHtml(val('interactionDate'))}</td></tr>
        <tr><td>Evaluator's name</td><td class="editable-cell" contenteditable="true" data-field="evaluator">${escapeHtml(val('evaluator'))}</td><td>Evaluation date</td><td class="editable-cell" contenteditable="true" data-field="evalDate">${escapeHtml(val('evalDate'))}</td></tr>
      </tbody>
    </table>

    <table class="audit body" style="margin-top:14px;">
      <thead>
        <tr><th>Category</th><th>Parameter</th><th>Constraint</th><th>Remark</th></tr>
      </thead>
      <tbody>
        ${bodyRows}
      </tbody>
    </table>
  `;

  attachPreviewEditHandlers();
}

// Lets people edit values directly in the preview table, not just the form above.
// Syncs back into the same form inputs / rows array so Save, Copy, and the draft
// all stay consistent no matter where the edit happened. Syncing on 'input' (not
// just 'blur') means a refresh mid-edit can't lose anything.
function attachPreviewEditHandlers() {
  report.querySelectorAll('[data-field]').forEach(cell => {
    cell.addEventListener('input', () => {
      const fieldId = cell.getAttribute('data-field');
      const input = document.getElementById(fieldId);
      if (input) input.value = cell.textContent;
      saveDraft();
    });
    cell.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); cell.blur(); }
    });
  });

  report.querySelectorAll('[data-idx][data-key]').forEach(cell => {
    cell.addEventListener('input', () => {
      const idx = cell.getAttribute('data-idx');
      const key = cell.getAttribute('data-key');
      rows[idx][key] = cell.textContent;
      saveDraft();
    });
    cell.addEventListener('blur', () => {
      // Full re-render of the row editors only on blur, so the row-editor panel
      // doesn't rebuild (and steal focus) on every keystroke.
      renderRowEditors();
    });
  });
}

// Extra safety net: force one last save if the tab closes or refreshes mid-edit.
window.addEventListener('beforeunload', saveDraft);

/* ---------------- Keyboard shortcuts ---------------- */

document.addEventListener('keydown', e => {
  const isSaveShortcut = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's';
  if (isSaveShortcut) {
    e.preventDefault();
    document.getElementById('saveBtn').click();
  }
});

/* ---------------- Firestore backend ---------------- */

function matchesSearch(data, term) {
  if (!term) return true;
  const haystack = `${data.winId || ''} ${data.agentName || ''} ${data.caseId || ''} ${data.hdrWin || ''}`.toLowerCase();
  return haystack.includes(term);
}

function renderSavedListFromDocs(docs) {
  const term = (searchInput.value || '').trim().toLowerCase();
  const filtered = docs.filter(d => matchesSearch(d.data(), term));

  if (!filtered.length) {
    savedListEl.innerHTML = docs.length
      ? '<p class="empty-note">No saved audits match that search.</p>'
      : '<p class="empty-note">No saved audits yet. Fill in the form below and click "Save audit".</p>';
    return;
  }

  savedListEl.innerHTML = '';
  filtered.forEach(d => {
    const data = d.data();
    const item = document.createElement('div');
    item.className = 'saved-item';
    const savedAt = data.savedAt && data.savedAt.toDate ? data.savedAt.toDate().toLocaleString() : '';
    item.innerHTML = `
      <div class="meta-text">
        <div class="win">WIN ${escapeHtml(data.winId || '—')} · ${escapeHtml(data.agentName || 'Unnamed agent')}</div>
        <div class="sub">Case ${escapeHtml(data.caseId || '—')} · saved ${escapeHtml(savedAt)}</div>
      </div>
      <div class="saved-actions">
        <button class="btn" type="button" data-load="${d.id}">Load</button>
        <button class="btn" type="button" data-duplicate="${d.id}">Duplicate</button>
        <button class="btn btn-danger" type="button" data-delete="${d.id}">Delete</button>
      </div>
    `;
    savedListEl.appendChild(item);
  });

  savedListEl.querySelectorAll('[data-load]').forEach(btn => {
    btn.addEventListener('click', () => loadAudit(btn.getAttribute('data-load')));
  });
  savedListEl.querySelectorAll('[data-duplicate]').forEach(btn => {
    btn.addEventListener('click', () => duplicateAudit(btn.getAttribute('data-duplicate')));
  });
  savedListEl.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', () => deleteAudit(btn.getAttribute('data-delete')));
  });
}

searchInput.addEventListener('input', () => renderSavedListFromDocs(latestDocs));

// Live sync: any save/delete (from this tab or another) updates the list automatically.
try {
  const q = query(auditsCol, orderBy('savedAt', 'desc'));
  onSnapshot(q, snapshot => {
    latestDocs = snapshot.docs;
    renderSavedListFromDocs(latestDocs);
  }, err => {
    console.error(err);
    savedListEl.innerHTML = '<p class="empty-note">Could not connect to Firestore. Check your config and security rules.</p>';
  });
} catch (e) {
  console.error(e);
  savedListEl.innerHTML = '<p class="empty-note">Could not connect to Firestore.</p>';
}

async function loadAudit(id) {
  setStatus('Loading…');
  try {
    const snap = await getDoc(doc(db, 'audits', id));
    if (!snap.exists()) {
      setStatus('That audit could not be found', 'err');
      return;
    }
    currentAuditId = id;
    applyFormData(snap.data());
    saveDraft();
    setStatus('Loaded', 'ok');
  } catch (e) {
    console.error(e);
    setStatus('Failed to load audit', 'err');
  }
}

// Pulls a saved audit's full details into the form as an unsaved draft (currentAuditId
// stays null), so the next Save creates a brand-new document instead of overwriting it.
async function duplicateAudit(id) {
  setStatus('Duplicating…');
  try {
    const snap = await getDoc(doc(db, 'audits', id));
    if (!snap.exists()) {
      setStatus('That audit could not be found', 'err');
      return;
    }
    currentAuditId = null;
    applyFormData(snap.data());
    saveDraft();
    setStatus('Duplicated as a new draft — edit and Save', 'ok');
  } catch (e) {
    console.error(e);
    setStatus('Failed to duplicate audit', 'err');
  }
}

async function deleteAudit(id) {
  if (!confirm('Delete this saved audit? This cannot be undone.')) return;
  setStatus('Deleting…');
  try {
    await deleteDoc(doc(db, 'audits', id));
    if (currentAuditId === id) currentAuditId = null;
    setStatus('Deleted', 'ok');
  } catch (e) {
    console.error(e);
    setStatus('Failed to delete audit', 'err');
  }
}

document.getElementById('saveBtn').addEventListener('click', async () => {
  const winIdVal = val('winId').trim();
  if (!winIdVal) {
    setStatus('Enter a WIN ID before saving', 'err');
    return;
  }

  const saveBtn = document.getElementById('saveBtn');
  saveBtn.disabled = true;
  setStatus('Saving…');

  try {
    const data = collectFormData();
    data.savedAt = serverTimestamp();

    if (currentAuditId) {
      await updateDoc(doc(db, 'audits', currentAuditId), data);
    } else {
      const ref = await addDoc(auditsCol, data);
      currentAuditId = ref.id;
    }
    rememberPeople();
    saveDraft();
    setStatus('Saved', 'ok');
  } catch (e) {
    console.error(e);
    setStatus('Failed to save — try again', 'err');
  } finally {
    saveBtn.disabled = false;
  }
});

/* ---------------- Init ---------------- */
const existingDraft = loadDraft();
if (existingDraft) {
  currentAuditId = existingDraft.currentAuditId || null;
  rows = Array.isArray(existingDraft.rows) && existingDraft.rows.length ? existingDraft.rows : [blankRow()];
  renderRowEditors();
  headerFields.forEach(id => {
    if (id === 'evaluator') return; // handled by applyEvaluatorLockState below
    if (id in existingDraft) document.getElementById(id).value = existingDraft[id] || '';
  });
  applyEvaluatorLockState();
  render();
} else {
  renderRowEditors();
  applyEvaluatorLockState();
  render();
}
