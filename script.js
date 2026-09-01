import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc,
  getDoc, onSnapshot, query, orderBy, serverTimestamp, writeBatch
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
const QA_FORM_LINK_KEY = 'qaFormLinkV1'; // URL of the separate QA audit form/tool

let ROSTER = {}; // WIN ID -> { agentName, teamLeader }, loaded from roster.json
fetch('roster.json')
  .then(r => r.ok ? r.json() : Promise.reject(new Error('roster.json not found')))
  .then(data => { ROSTER = data; })
  .catch(err => console.error('Could not load roster.json — WIN ID auto-fill will be unavailable.', err));

const rowsContainer = document.getElementById('rowsContainer');
const report = document.getElementById('report');
const savedListEl = document.getElementById('savedList');
const savedListWrapper = savedListEl.parentElement;
const savedAuditsModal = document.getElementById('savedAuditsModal');
const openSavedAuditsBtn = document.getElementById('openSavedAuditsBtn');
const closeSavedAuditsBtn = document.getElementById('closeSavedAuditsBtn');
const unsentBadge = document.getElementById('unsentBadge');

const deletedListEl = document.getElementById('deletedList');
const deletedAuditsModal = document.getElementById('deletedAuditsModal');
const openDeletedBtn = document.getElementById('openDeletedBtn');
const closeDeletedModalBtn = document.getElementById('closeDeletedModalBtn');
const deletedBadge = document.getElementById('deletedBadge');

const archivedListEl = document.getElementById('archivedList');
const archivedAuditsModal = document.getElementById('archivedAuditsModal');
const openArchivedBtn = document.getElementById('openArchivedBtn');
const closeArchivedModalBtn = document.getElementById('closeArchivedModalBtn');
const archivedBadge = document.getElementById('archivedBadge');

function openSavedAuditsModal() {
  savedAuditsModal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeSavedAuditsModal() {
  savedAuditsModal.style.display = 'none';
  document.body.style.overflow = '';
}

function openDeletedModal() {
  deletedAuditsModal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeDeletedModal() {
  deletedAuditsModal.style.display = 'none';
  document.body.style.overflow = '';
}

function openArchivedModal() {
  archivedAuditsModal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeArchivedModal() {
  archivedAuditsModal.style.display = 'none';
  document.body.style.overflow = '';
}

openSavedAuditsBtn.addEventListener('click', openSavedAuditsModal);
closeSavedAuditsBtn.addEventListener('click', closeSavedAuditsModal);
savedAuditsModal.addEventListener('click', e => { if (e.target === savedAuditsModal) closeSavedAuditsModal(); });

openDeletedBtn.addEventListener('click', openDeletedModal);
closeDeletedModalBtn.addEventListener('click', closeDeletedModal);
deletedAuditsModal.addEventListener('click', e => { if (e.target === deletedAuditsModal) closeDeletedModal(); });

openArchivedBtn.addEventListener('click', openArchivedModal);
closeArchivedModalBtn.addEventListener('click', closeArchivedModal);
archivedAuditsModal.addEventListener('click', e => { if (e.target === archivedAuditsModal) closeArchivedModal(); });

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (savedAuditsModal.style.display === 'flex') closeSavedAuditsModal();
  if (deletedAuditsModal.style.display === 'flex') closeDeletedModal();
  if (archivedAuditsModal.style.display === 'flex') closeArchivedModal();
});
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

// Retroactively pushes the current evaluator name onto every saved audit in Firestore,
// not just new ones going forward. Firestore batches cap at 500 writes, so large
// collections are split into chunks and committed one at a time.
document.getElementById('applyEvaluatorAllBtn').addEventListener('click', async () => {
  const name = val('evaluator').trim();
  if (!name) {
    setStatus('Type and lock a name first', 'err');
    return;
  }
  const activeDocs = latestDocs.filter(d => !d.data().deleted);
  if (!activeDocs.length) {
    setStatus('No saved audits to update', 'err');
    return;
  }
  const count = activeDocs.length;
  if (!confirm(`Update the evaluator name to "${name}" on all ${count} saved audit${count === 1 ? '' : 's'}? This cannot be undone.`)) {
    return;
  }

  setStatus(`Updating ${count} saved audits…`);
  try {
    const chunkSize = 450;
    for (let i = 0; i < activeDocs.length; i += chunkSize) {
      const chunk = activeDocs.slice(i, i + chunkSize);
      const batch = writeBatch(db);
      chunk.forEach(d => batch.update(doc(db, 'audits', d.id), { evaluator: name }));
      await batch.commit();
    }
    setStatus(`Updated evaluator name on ${count} saved audits`, 'ok');
  } catch (e) {
    console.error(e);
    setStatus('Failed to update all audits — try again', 'err');
  }
});

/* ---------------- QA form link ---------------- */

const qaFormLinkInput = document.getElementById('qaFormLink');
const qaFormLinkLockBtn = document.getElementById('qaFormLinkLockBtn');

function applyQaFormLinkState() {
  const saved = localStorage.getItem(QA_FORM_LINK_KEY);
  if (saved) {
    qaFormLinkInput.value = saved;
    qaFormLinkInput.readOnly = true;
    qaFormLinkLockBtn.textContent = 'Edit';
  } else {
    qaFormLinkInput.readOnly = false;
    qaFormLinkLockBtn.textContent = 'Lock';
  }
}

qaFormLinkLockBtn.addEventListener('click', () => {
  if (qaFormLinkInput.readOnly) {
    qaFormLinkInput.readOnly = false;
    qaFormLinkLockBtn.textContent = 'Lock';
    qaFormLinkInput.focus();
  } else {
    const link = qaFormLinkInput.value.trim();
    if (!link) {
      setStatus('Paste your QA form link before locking it', 'err');
      return;
    }
    localStorage.setItem(QA_FORM_LINK_KEY, link);
    qaFormLinkInput.readOnly = true;
    qaFormLinkLockBtn.textContent = 'Edit';
    setStatus('QA form link locked', 'ok');
  }
});

document.getElementById('openQaFormBtn').addEventListener('click', () => {
  const link = localStorage.getItem(QA_FORM_LINK_KEY);
  if (!link) {
    setStatus('Set your QA form link above first', 'err');
    return;
  }
  window.open(link, '_blank', 'noopener');
});

applyQaFormLinkState();

/* ---------------- Floating preview (picture-in-picture) ---------------- */

const pipWindow = document.getElementById('pipWindow');
const pipHeader = document.getElementById('pipHeader');
const pipContent = document.getElementById('pipContent');
const pipTitle = document.getElementById('pipTitle');
const pipLiveBtn = document.getElementById('pipLiveBtn');
const pipMinimizeBtn = document.getElementById('pipMinimizeBtn');
const pipCloseBtn = document.getElementById('pipCloseBtn');
const togglePipBtn = document.getElementById('togglePipBtn');

// When true, the PiP is "pinned" to a specific saved audit (via the Load button) and
// should NOT be overwritten by whatever's currently in the main form — that's the whole
// point of viewing a past audit without disturbing what you're actively working on.
let pipPinned = false;

function syncPipContent() {
  if (pipWindow.style.display === 'none' || pipPinned) return;
  pipContent.innerHTML = report.innerHTML;
  // The floating window is a read-only mirror — editing still happens in the main preview/form.
  pipContent.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));
}

function openPip() {
  pipWindow.style.display = 'flex';
  syncPipContent();
}

function closePip() {
  pipWindow.style.display = 'none';
  pipPinned = false;
  pipLiveBtn.style.display = 'none';
  pipTitle.textContent = 'Preview';
}

// Shows a saved audit's report in the floating window as a static, read-only snapshot —
// separate from whatever's currently in the main form, so nothing you've typed gets lost.
async function viewAuditInPip(id) {
  setStatus('Loading preview…');
  try {
    const snap = await getDoc(doc(db, 'audits', id));
    if (!snap.exists()) {
      setStatus('That audit could not be found', 'err');
      return;
    }
    const data = snap.data();
    pipPinned = true;
    pipContent.innerHTML = buildStaticReportHtml(data);
    pipTitle.textContent = `WIN ${data.winId || '—'} (saved — not your current form)`;
    pipLiveBtn.style.display = 'inline-flex';
    pipWindow.style.display = 'flex';
    closeSavedAuditsModal();
    setStatus('Viewing saved audit — your current form is untouched', 'ok');
  } catch (e) {
    console.error(e);
    setStatus('Failed to load preview', 'err');
  }
}

togglePipBtn.addEventListener('click', () => {
  if (pipWindow.style.display === 'none') openPip(); else closePip();
});
pipCloseBtn.addEventListener('click', closePip);
pipLiveBtn.addEventListener('click', () => {
  pipPinned = false;
  pipLiveBtn.style.display = 'none';
  pipTitle.textContent = 'Preview';
  syncPipContent();
});
pipMinimizeBtn.addEventListener('click', () => {
  pipWindow.classList.toggle('minimized');
  pipMinimizeBtn.textContent = pipWindow.classList.contains('minimized') ? '□' : '–';
});

// Drag-to-move by the header, like a real picture-in-picture window.
let pipDragging = false, pipOffsetX = 0, pipOffsetY = 0;
pipHeader.addEventListener('mousedown', e => {
  if (e.target.closest('.pip-btn')) return;
  pipDragging = true;
  const rect = pipWindow.getBoundingClientRect();
  pipOffsetX = e.clientX - rect.left;
  pipOffsetY = e.clientY - rect.top;
  document.body.style.userSelect = 'none';
});
document.addEventListener('mousemove', e => {
  if (!pipDragging) return;
  pipWindow.style.left = `${e.clientX - pipOffsetX}px`;
  pipWindow.style.top = `${e.clientY - pipOffsetY}px`;
  pipWindow.style.right = 'auto';
  pipWindow.style.bottom = 'auto';
});
document.addEventListener('mouseup', () => {
  pipDragging = false;
  document.body.style.userSelect = '';
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

function todayFormatted() {
  const d = new Date();
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

document.getElementById('newBtn').addEventListener('click', () => {
  currentAuditId = null;
  const remembered = recallPeople() || {};
  applyFormData({
    hdrWin: '', winId: '', ani: '', agentName: '', caseId: '',
    teamLeader: remembered.teamLeader || '',
    interactionDate: '',
    evalDate: todayFormatted(),
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
// Finds runs of consecutive findings that share the same (non-blank) category, so the
// category cell can be rendered once with a rowspan instead of repeating on every row.
// Returns an array the same length as rowsArr: a positive number = "render this row's
// category cell with this rowspan", 0 = "skip the category cell, it's covered above".
// Computes rowspans for one column of an already-ordered row list: a positive number
// means "render this row's cell with this rowspan," 0 means "skip it, a cell above
// covers it." requireMatchKeys lets a column only merge when other columns (e.g.
// category) also match, so Parameter never merges across two different Categories.
function computeSpans(orderedRowsArr, keyName, requireMatchKeys = []) {
  const spans = new Array(orderedRowsArr.length).fill(0);
  let i = 0;
  while (i < orderedRowsArr.length) {
    let j = i;
    while (
      orderedRowsArr[i][keyName] &&
      j + 1 < orderedRowsArr.length &&
      orderedRowsArr[j + 1][keyName] === orderedRowsArr[i][keyName] &&
      requireMatchKeys.every(k => orderedRowsArr[j + 1][k] === orderedRowsArr[i][k])
    ) {
      j++;
    }
    spans[i] = j - i + 1;
    i = j + 1;
  }
  return spans;
}

// Returns the original array indices reordered so every row sharing a Category sits
// together, and within each Category, rows sharing a Parameter sit together too — even
// if they weren't added consecutively. Groups appear in the order they were first seen;
// a blank category/parameter never merges with another blank one. The Findings editor
// below the preview is unaffected — this only changes how the preview and copied report
// are laid out.
function groupedOrderByCategory(rowsArr) {
  const catKeys = [];
  const catGroups = {};
  rowsArr.forEach((r, idx) => {
    const key = r.category ? r.category : `__blank_cat_${idx}`;
    if (!(key in catGroups)) { catGroups[key] = []; catKeys.push(key); }
    catGroups[key].push(idx);
  });

  const order = [];
  catKeys.forEach(catKey => {
    const indices = catGroups[catKey];
    const paramKeys = [];
    const paramGroups = {};
    indices.forEach(idx => {
      const pKey = rowsArr[idx].parameter ? rowsArr[idx].parameter : `__blank_param_${idx}`;
      if (!(pKey in paramGroups)) { paramGroups[pKey] = []; paramKeys.push(pKey); }
      paramGroups[pKey].push(idx);
    });
    paramKeys.forEach(pKey => order.push(...paramGroups[pKey]));
  });
  return order;
}

// Renders a saved audit's report from its raw Firestore data — used for the "Load"
// (view-only) button in the saved-audits list, so viewing an old audit never touches
// whatever's currently in the live form/rows.
function buildStaticReportHtml(data) {
  const rowsForDoc = Array.isArray(data.rows) ? data.rows : [];
  const order = groupedOrderByCategory(rowsForDoc);
  const orderedRows = order.map(idx => rowsForDoc[idx]);
  const categorySpans = computeSpans(orderedRows, 'category');
  const parameterSpans = computeSpans(orderedRows, 'parameter', ['category']);

  const bodyRows = orderedRows.map((r, k) => {
    const categoryCell = categorySpans[k] > 0
      ? `<td class="cell-category static-cell"${categorySpans[k] > 1 ? ` rowspan="${categorySpans[k]}"` : ''}>${escapeHtml(r.category)}</td>`
      : '';
    const parameterCell = parameterSpans[k] > 0
      ? `<td class="cell-parameter static-cell"${parameterSpans[k] > 1 ? ` rowspan="${parameterSpans[k]}"` : ''}>${escapeHtml(r.parameter)}</td>`
      : '';
    return `
      <tr>
        ${categoryCell}
        ${parameterCell}
        <td class="cell-constraint">${escapeHtml(r.constraint)}</td>
        <td class="cell-remark">${escapeHtml(r.remark)}</td>
      </tr>
    `;
  }).join('');

  return `
    <p>Hi @${escapeHtml(data.agentName || '')},</p>
    <p>Please see below your audit ${escapeHtml(data.hdrWin || '')}. We encourage you to review the areas of opportunity highlighted, as these will support continuous improvement. Your acknowledgment will be sincerely appreciated.</p>
    <p>Hi TL @${escapeHtml(data.teamLeader || '')},</p>
    <p>Kindly help us coach the agent immediately to avoid the recurrence of the observed opportunity.</p>

    <table class="audit meta" style="margin-top:14px;">
      <tbody>
        <tr><td>WIN ID</td><td>${escapeHtml(data.winId || '')}</td><td>ANI/MIN</td><td style="font-weight:700;">${escapeHtml(data.ani || '')}</td></tr>
        <tr><td>Agent name</td><td>${escapeHtml(data.agentName || '')}</td><td>Call/case ID</td><td>${escapeHtml(data.caseId || '')}</td></tr>
        <tr><td>Team leader</td><td>${escapeHtml(data.teamLeader || '')}</td><td>Date and time of interaction</td><td>${escapeHtml(data.interactionDate || '')}</td></tr>
        <tr><td>Evaluator's name</td><td>${escapeHtml(data.evaluator || '')}</td><td>Evaluation date</td><td>${escapeHtml(data.evalDate || '')}</td></tr>
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
}

function buildInlineStyledReport() {
  const cellStyle = 'border:1px solid #8c8c8c;padding:8px 10px;vertical-align:top;font-size:13px;font-family:Calibri,Arial,sans-serif;';
  const greenCellStyle = cellStyle + 'background-color:#c6e0b4;font-weight:700;';
  const yellowHeaderStyle = cellStyle + 'background-color:#ffe699;font-weight:700;text-align:center;';
  const boldCellStyle = cellStyle + 'font-weight:700;';
  const categoryCellStyle = cellStyle + 'font-weight:700;text-align:center;vertical-align:middle;';
  const parameterCellStyle = cellStyle + 'text-align:center;text-transform:uppercase;vertical-align:middle;';
  const constraintCellStyle = cellStyle + 'text-align:center;';
  const tableAttrs = 'border="1" cellpadding="8" cellspacing="0" bordercolor="#8c8c8c"';
  const tableStyle = 'border-collapse:collapse;border:1px solid #8c8c8c;width:100%;margin-top:14px;';
  const pStyle = 'margin:0 0 10px;line-height:1.5;font-family:Calibri,Arial,sans-serif;font-size:13.5px;color:#000;';

  const order = groupedOrderByCategory(rows);
  const orderedRows = order.map(idx => rows[idx]);
  const categorySpans = computeSpans(orderedRows, 'category');
  const parameterSpans = computeSpans(orderedRows, 'parameter', ['category']);
  const bodyRows = orderedRows.map((r, k) => {
    const categoryCell = categorySpans[k] > 0
      ? `<td ${tableAttrs} style="${categoryCellStyle}"${categorySpans[k] > 1 ? ` rowspan="${categorySpans[k]}"` : ''}>${escapeHtml(r.category)}</td>`
      : '';
    const parameterCell = parameterSpans[k] > 0
      ? `<td ${tableAttrs} style="${parameterCellStyle}"${parameterSpans[k] > 1 ? ` rowspan="${parameterSpans[k]}"` : ''}>${escapeHtml(r.parameter)}</td>`
      : '';
    return `
    <tr>
      ${categoryCell}
      ${parameterCell}
      <td ${tableAttrs} style="${constraintCellStyle}">${escapeHtml(r.constraint)}</td>
      <td ${tableAttrs} style="${cellStyle}">${escapeHtml(r.remark)}</td>
    </tr>
  `;
  }).join('');

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
  const order = groupedOrderByCategory(rows);
  const orderedRows = order.map(idx => rows[idx]);
  const categorySpans = computeSpans(orderedRows, 'category');
  const parameterSpans = computeSpans(orderedRows, 'parameter', ['category']);
  const bodyRows = orderedRows.map((r, k) => {
    const originalIdx = order[k]; // edits must still write back to the real position in `rows`
    const categoryCell = categorySpans[k] > 0
      ? `<td class="cell-category static-cell"${categorySpans[k] > 1 ? ` rowspan="${categorySpans[k]}"` : ''}>${escapeHtml(r.category)}</td>`
      : '';
    const parameterCell = parameterSpans[k] > 0
      ? `<td class="cell-parameter static-cell"${parameterSpans[k] > 1 ? ` rowspan="${parameterSpans[k]}"` : ''}>${escapeHtml(r.parameter)}</td>`
      : '';
    return `
    <tr>
      ${categoryCell}
      ${parameterCell}
      <td class="cell-constraint editable-cell" contenteditable="true" data-idx="${originalIdx}" data-key="constraint">${escapeHtml(r.constraint)}</td>
      <td class="cell-remark editable-cell" contenteditable="true" data-idx="${originalIdx}" data-key="remark">${escapeHtml(r.remark)}</td>
    </tr>
  `;
  }).join('');

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
  syncPipContent();
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
  const activeDocs = docs.filter(d => !d.data().deleted && !d.data().archived);
  const term = (searchInput.value || '').trim().toLowerCase();
  const filtered = activeDocs.filter(d => matchesSearch(d.data(), term));

  const unsentCount = activeDocs.filter(d => !d.data().emailSent).length;
  const unloggedCount = activeDocs.filter(d => !d.data().loggedInQA).length;
  savedListWrapper.querySelector('.unsent-banner')?.remove();
  if (unsentCount > 0 || unloggedCount > 0) {
    const parts = [];
    if (unsentCount > 0) parts.push(unsentCount === 1 ? '1 audit not emailed' : `${unsentCount} audits not emailed`);
    if (unloggedCount > 0) parts.push(unloggedCount === 1 ? '1 audit not logged in the QA form' : `${unloggedCount} audits not logged in the QA form`);
    const banner = document.createElement('p');
    banner.className = 'unsent-banner';
    banner.textContent = `⚠ ${parts.join(' · ')}`;
    savedListWrapper.insertBefore(banner, savedListEl);
  }

  const badgeTotal = unsentCount + unloggedCount;
  if (badgeTotal > 0) {
    unsentBadge.textContent = badgeTotal;
    unsentBadge.style.display = 'inline-block';
  } else {
    unsentBadge.style.display = 'none';
  }

  if (!filtered.length) {
    savedListEl.innerHTML = activeDocs.length
      ? '<p class="empty-note">No saved audits match that search.</p>'
      : '<p class="empty-note">No saved audits yet. Fill in the form below and click "Save audit".</p>';
    return;
  }

  savedListEl.innerHTML = '';
  filtered.forEach(d => {
    const data = d.data();
    const sent = !!data.emailSent;
    const logged = !!data.loggedInQA;
    const item = document.createElement('div');
    item.className = 'saved-item';
    const savedAt = data.savedAt && data.savedAt.toDate ? data.savedAt.toDate().toLocaleString() : '';
    item.innerHTML = `
      <div class="meta-text">
        <div class="win">
          WIN ${escapeHtml(data.winId || '—')} · ${escapeHtml(data.agentName || 'Unnamed agent')}
          <span class="badge ${sent ? 'badge-sent' : 'badge-unsent'}">${sent ? '✓ Emailed' : '✉ Not emailed'}</span>
          <span class="badge ${logged ? 'badge-sent' : 'badge-unsent'}">${logged ? '✓ Logged' : '📝 Not logged'}</span>
        </div>
        <div class="sub">Case ${escapeHtml(data.caseId || '—')} · saved ${escapeHtml(savedAt)}</div>
      </div>
      <div class="saved-actions">
        <button class="btn" type="button" data-toggle-sent="${d.id}" data-sent="${sent}">${sent ? 'Mark not emailed' : 'Mark emailed'}</button>
        <button class="btn" type="button" data-toggle-logged="${d.id}" data-logged="${logged}">${logged ? 'Mark not logged' : 'Mark logged'}</button>
        <button class="btn" type="button" data-load="${d.id}" title="View without touching your current form">Load</button>
        <button class="btn" type="button" data-edit="${d.id}" title="Load into the form for editing — replaces what's currently in the form">Edit</button>
        <button class="btn" type="button" data-duplicate="${d.id}">Duplicate</button>
        <button class="btn btn-danger" type="button" data-delete="${d.id}">Delete</button>
      </div>
    `;
    savedListEl.appendChild(item);
  });

  savedListEl.querySelectorAll('[data-load]').forEach(btn => {
    btn.addEventListener('click', () => viewAuditInPip(btn.getAttribute('data-load')));
  });
  savedListEl.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', () => loadAudit(btn.getAttribute('data-edit')));
  });
  savedListEl.querySelectorAll('[data-duplicate]').forEach(btn => {
    btn.addEventListener('click', () => duplicateAudit(btn.getAttribute('data-duplicate')));
  });
  savedListEl.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', () => deleteAudit(btn.getAttribute('data-delete')));
  });
  savedListEl.querySelectorAll('[data-toggle-sent]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-toggle-sent');
      const currentlySent = btn.getAttribute('data-sent') === 'true';
      toggleEmailSent(id, currentlySent);
    });
  });
  savedListEl.querySelectorAll('[data-toggle-logged]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-toggle-logged');
      const currentlyLogged = btn.getAttribute('data-logged') === 'true';
      toggleLoggedInQA(id, currentlyLogged);
    });
  });
}

async function toggleEmailSent(id, currentlySent) {
  try {
    await updateDoc(doc(db, 'audits', id), { emailSent: !currentlySent });
    setStatus(currentlySent ? 'Marked as not emailed' : 'Marked as emailed', 'ok');
  } catch (e) {
    console.error(e);
    setStatus('Could not update email status', 'err');
  }
}

async function toggleLoggedInQA(id, currentlyLogged) {
  try {
    await updateDoc(doc(db, 'audits', id), { loggedInQA: !currentlyLogged });
    setStatus(currentlyLogged ? 'Marked as not logged' : 'Marked as logged in QA form', 'ok');
  } catch (e) {
    console.error(e);
    setStatus('Could not update QA log status', 'err');
  }
}

function renderDeletedListFromDocs(docs) {
  const deleted = docs.filter(d => d.data().deleted);

  deletedBadge.textContent = deleted.length;
  deletedBadge.style.display = deleted.length > 0 ? 'inline-block' : 'none';

  if (!deleted.length) {
    deletedListEl.innerHTML = '<p class="empty-note">Nothing here — anything you delete shows up in this list until you permanently remove it.</p>';
    return;
  }

  deletedListEl.innerHTML = '';
  deleted.forEach(d => {
    const data = d.data();
    const item = document.createElement('div');
    item.className = 'saved-item';
    const deletedAt = data.deletedAt && data.deletedAt.toDate ? data.deletedAt.toDate().toLocaleString() : '';
    item.innerHTML = `
      <div class="meta-text">
        <div class="win">WIN ${escapeHtml(data.winId || '—')} · ${escapeHtml(data.agentName || 'Unnamed agent')}</div>
        <div class="sub">Case ${escapeHtml(data.caseId || '—')} · deleted ${escapeHtml(deletedAt)}</div>
      </div>
      <div class="saved-actions">
        <button class="btn" type="button" data-restore="${d.id}">Restore</button>
        <button class="btn btn-danger" type="button" data-perm-delete="${d.id}">Delete permanently</button>
      </div>
    `;
    deletedListEl.appendChild(item);
  });

  deletedListEl.querySelectorAll('[data-restore]').forEach(btn => {
    btn.addEventListener('click', () => restoreAudit(btn.getAttribute('data-restore')));
  });
  deletedListEl.querySelectorAll('[data-perm-delete]').forEach(btn => {
    btn.addEventListener('click', () => permanentlyDeleteAudit(btn.getAttribute('data-perm-delete')));
  });
}

async function restoreAudit(id) {
  setStatus('Restoring…');
  try {
    await updateDoc(doc(db, 'audits', id), { deleted: false, deletedAt: null });
    setStatus('Restored to saved audits', 'ok');
  } catch (e) {
    console.error(e);
    setStatus('Failed to restore audit', 'err');
  }
}

async function permanentlyDeleteAudit(id) {
  if (!confirm('Permanently delete this audit? This cannot be undone.')) return;
  setStatus('Permanently deleting…');
  try {
    await deleteDoc(doc(db, 'audits', id));
    setStatus('Permanently deleted', 'ok');
  } catch (e) {
    console.error(e);
    setStatus('Failed to permanently delete', 'err');
  }
}

function renderArchivedListFromDocs(docs) {
  const archived = docs.filter(d => d.data().archived && !d.data().deleted);

  archivedBadge.textContent = archived.length;
  archivedBadge.style.display = archived.length > 0 ? 'inline-block' : 'none';

  if (!archived.length) {
    archivedListEl.innerHTML = '<p class="empty-note">Nothing archived yet. Use "Archive all" in Saved audits to tuck away everything currently in your active list.</p>';
    return;
  }

  archivedListEl.innerHTML = '';
  archived.forEach(d => {
    const data = d.data();
    const item = document.createElement('div');
    item.className = 'saved-item';
    const archivedAt = data.archivedAt && data.archivedAt.toDate ? data.archivedAt.toDate().toLocaleString() : '';
    item.innerHTML = `
      <div class="meta-text">
        <div class="win">WIN ${escapeHtml(data.winId || '—')} · ${escapeHtml(data.agentName || 'Unnamed agent')}</div>
        <div class="sub">Case ${escapeHtml(data.caseId || '—')} · archived ${escapeHtml(archivedAt)}</div>
      </div>
      <div class="saved-actions">
        <button class="btn" type="button" data-view-archived="${d.id}">Load</button>
        <button class="btn" type="button" data-unarchive="${d.id}">Unarchive</button>
        <button class="btn btn-danger" type="button" data-delete-archived="${d.id}">Delete</button>
      </div>
    `;
    archivedListEl.appendChild(item);
  });

  archivedListEl.querySelectorAll('[data-view-archived]').forEach(btn => {
    btn.addEventListener('click', () => viewAuditInPip(btn.getAttribute('data-view-archived')));
  });
  archivedListEl.querySelectorAll('[data-unarchive]').forEach(btn => {
    btn.addEventListener('click', () => unarchiveAudit(btn.getAttribute('data-unarchive')));
  });
  archivedListEl.querySelectorAll('[data-delete-archived]').forEach(btn => {
    btn.addEventListener('click', () => deleteAudit(btn.getAttribute('data-delete-archived')));
  });
}

async function unarchiveAudit(id) {
  setStatus('Restoring to saved audits…');
  try {
    await updateDoc(doc(db, 'audits', id), { archived: false, archivedAt: null });
    setStatus('Moved back to saved audits', 'ok');
  } catch (e) {
    console.error(e);
    setStatus('Failed to unarchive audit', 'err');
  }
}

// Bulk-moves every currently active (non-deleted, non-archived) audit into storage.
document.getElementById('archiveAllBtn').addEventListener('click', async () => {
  const activeDocs = latestDocs.filter(d => !d.data().deleted && !d.data().archived);
  if (!activeDocs.length) {
    setStatus('No saved audits to archive', 'err');
    return;
  }
  const count = activeDocs.length;
  if (!confirm(`Archive all ${count} saved audit${count === 1 ? '' : 's'}? They'll move out of this list into Archived, and you can restore any of them anytime.`)) {
    return;
  }

  setStatus(`Archiving ${count} audits…`);
  try {
    const chunkSize = 450;
    for (let i = 0; i < activeDocs.length; i += chunkSize) {
      const chunk = activeDocs.slice(i, i + chunkSize);
      const batch = writeBatch(db);
      chunk.forEach(d => batch.update(doc(db, 'audits', d.id), { archived: true, archivedAt: serverTimestamp() }));
      await batch.commit();
    }
    setStatus(`Archived ${count} audits`, 'ok');
  } catch (e) {
    console.error(e);
    setStatus('Failed to archive all — try again', 'err');
  }
});

searchInput.addEventListener('input', () => renderSavedListFromDocs(latestDocs));

// Live sync: any save/delete (from this tab or another) updates the list automatically.
try {
  const q = query(auditsCol, orderBy('savedAt', 'desc'));
  onSnapshot(q, snapshot => {
    latestDocs = snapshot.docs;
    renderSavedListFromDocs(latestDocs);
    renderDeletedListFromDocs(latestDocs);
    renderArchivedListFromDocs(latestDocs);
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
    closeSavedAuditsModal();
    setStatus('Loaded into the form for editing', 'ok');
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
    closeSavedAuditsModal();
    setStatus('Duplicated as a new draft — edit and Save', 'ok');
  } catch (e) {
    console.error(e);
    setStatus('Failed to duplicate audit', 'err');
  }
}

async function deleteAudit(id) {
  if (!confirm('Move this audit to Deleted? You can restore it from the Deleted list later.')) return;
  setStatus('Deleting…');
  try {
    await updateDoc(doc(db, 'audits', id), { deleted: true, deletedAt: serverTimestamp() });
    if (currentAuditId === id) currentAuditId = null;
    setStatus('Moved to Deleted', 'ok');
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
      data.emailSent = false; // new audits always start as not-yet-sent
      data.loggedInQA = false; // and not-yet-logged in the separate QA form
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
} else {
  renderRowEditors();
  applyEvaluatorLockState();
}

// Evaluation date defaults to today whenever it's blank — whether this is a brand-new
// session or a restored draft that never had a date filled in.
if (!val('evalDate')) {
  document.getElementById('evalDate').value = todayFormatted();
  saveDraft();
}
render();
