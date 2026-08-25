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
  const defaultRows = [
    { category: "Reliable", parameter: "What hinders the agent to provide a reliable solution to the customer?", constraint: "No ticket created", remark: "Since the SIM was reported lost on December 5, 2025, the agent advised the customer that the outgoing service of the lost SIM had been deactivated to prevent unnecessary charges. However, the agent failed to create the corresponding deactivation case." },
    { category: "Personable", parameter: "Were there other agent factors observed that affected the customer's experience?", constraint: "Customer validation and empathy gap", remark: "Lack of empathy; the agent should have shown empathy in his reply, as the request was originally made in December 2025, and the customer followed up again in March, but the issue remained unresolved." },
    { category: "Safe and secure", parameter: "Did we follow the system documentation process?", constraint: "Incomplete and incorrect documentation", remark: "The agent should have documented in his notes that he processed the deactivation of the features. Additionally, the agent's SFDC notes indicated that the case was staged to ACR. However, in CEM, the case was staged as AAI because the agent was requesting the customer to provide the required SIM replacement details." }
  ];

  let rows = JSON.parse(JSON.stringify(defaultRows));
  let currentAuditId = null;

  const rowsContainer = document.getElementById('rowsContainer');
  const report = document.getElementById('report');
  const savedListEl = document.getElementById('savedList');
  const statusMsg = document.getElementById('statusMsg');

  const headerFields = ['hdrAgent', 'hdrTL', 'hdrWin', 'winId', 'ani', 'agentName', 'caseId', 'teamLeader', 'interactionDate', 'evaluator', 'evalDate'];
  headerFields.forEach(id => document.getElementById(id).addEventListener('input', render));

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
    headerFields.forEach(id => { if (id in data) document.getElementById(id).value = data[id] || ''; });
    rows = Array.isArray(data.rows) ? JSON.parse(JSON.stringify(data.rows)) : [blankRow()];
    renderRowEditors();
    render();
  }

  function renderRowEditors() {
    rowsContainer.innerHTML = '';
    rows.forEach((row, i) => {
      const item = document.createElement('div');
      item.className = 'row-item';
      item.innerHTML = `
        <div class="row-actions">
          <span>Finding ${i + 1}</span>
          <button class="btn btn-danger" type="button" data-remove="${i}">Remove</button>
        </div>
        <div class="field-grid">
          <div class="field"><label>Category</label><input data-idx="${i}" data-key="category" value="${escapeHtml(row.category)}"></div>
          <div class="field"><label>Parameter (question)</label><textarea data-idx="${i}" data-key="parameter">${escapeHtml(row.parameter)}</textarea></div>
          <div class="field"><label>Constraint</label><input data-idx="${i}" data-key="constraint" value="${escapeHtml(row.constraint)}"></div>
        </div>
        <div class="field" style="margin-top:8px;">
          <label>Remark / narrative</label>
          <textarea data-idx="${i}" data-key="remark" style="min-height:80px;">${escapeHtml(row.remark)}</textarea>
        </div>
      `;
      rowsContainer.appendChild(item);
    });

    rowsContainer.querySelectorAll('input, textarea').forEach(el => {
      el.addEventListener('input', e => {
        const idx = e.target.getAttribute('data-idx');
        const key = e.target.getAttribute('data-key');
        rows[idx][key] = e.target.value;
        render();
      });
    });

    rowsContainer.querySelectorAll('[data-remove]').forEach(btn => {
      btn.addEventListener('click', e => {
        const idx = parseInt(e.target.getAttribute('data-remove'));
        rows.splice(idx, 1);
        renderRowEditors();
        render();
      });
    });
  }

  document.getElementById('addRowBtn').addEventListener('click', () => {
    rows.push(blankRow());
    renderRowEditors();
    render();
  });

  document.getElementById('newBtn').addEventListener('click', () => {
    currentAuditId = null;
    applyFormData({
      hdrAgent: '', hdrTL: '', hdrWin: '',
      winId: '', ani: '', agentName: '', caseId: '', teamLeader: '',
      interactionDate: '', evaluator: '', evalDate: '',
      rows: [blankRow()]
    });
    setStatus('Started a blank audit', 'ok');
  });

  document.getElementById('printBtn').addEventListener('click', () => window.print());

  document.getElementById('copyBtn').addEventListener('click', async () => {
    render(); // make sure preview reflects the latest edits before copying
    const htmlContent = report.innerHTML;
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

  function render() {
    const bodyRows = rows.map(r => `
      <tr>
        <td>${escapeHtml(r.category)}</td>
        <td>${escapeHtml(r.parameter)}</td>
        <td>${escapeHtml(r.constraint)}</td>
        <td>${escapeHtml(r.remark)}</td>
      </tr>
    `).join('');

    report.innerHTML = `
      <p>Hi @${escapeHtml(val('hdrAgent'))},</p>
      <p>Please see below your audit ${escapeHtml(val('hdrWin'))}. We encourage you to review the areas of opportunity highlighted, as these will support continuous improvement. Your acknowledgment will be sincerely appreciated.</p>
      <p>Hi TL @${escapeHtml(val('hdrTL'))},</p>
      <p>Kindly help us coach the agent immediately to avoid the recurrence of the observed opportunity.</p>

      <table class="audit meta" style="margin-top:14px;">
        <tbody>
          <tr><td>WIN ID</td><td>${escapeHtml(val('winId'))}</td><td>ANI/MIN</td><td style="font-weight:700;">${escapeHtml(val('ani'))}</td></tr>
          <tr><td>Agent name</td><td>${escapeHtml(val('agentName'))}</td><td>Call/case ID</td><td>${escapeHtml(val('caseId'))}</td></tr>
          <tr><td>Team leader</td><td>${escapeHtml(val('teamLeader'))}</td><td>Date and time of interaction</td><td>${escapeHtml(val('interactionDate'))}</td></tr>
          <tr><td>Evaluator's name</td><td>${escapeHtml(val('evaluator'))}</td><td>Evaluation date</td><td>${escapeHtml(val('evalDate'))}</td></tr>
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

  /* ---------------- Firestore backend ---------------- */

  function renderSavedListFromDocs(docs) {
    if (!docs.length) {
      savedListEl.innerHTML = '<p class="empty-note">No saved audits yet. Fill in the form below and click "Save audit".</p>';
      return;
    }

    savedListEl.innerHTML = '';
    docs.forEach(d => {
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
          <button class="btn btn-danger" type="button" data-delete="${d.id}">Delete</button>
        </div>
      `;
      savedListEl.appendChild(item);
    });

    savedListEl.querySelectorAll('[data-load]').forEach(btn => {
      btn.addEventListener('click', () => loadAudit(btn.getAttribute('data-load')));
    });
    savedListEl.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', () => deleteAudit(btn.getAttribute('data-delete')));
    });
  }

  // Live sync: any save/delete (from this tab or another) updates the list automatically.
  try {
    const q = query(auditsCol, orderBy('savedAt', 'desc'));
    onSnapshot(q, snapshot => {
      renderSavedListFromDocs(snapshot.docs);
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
      setStatus('Loaded', 'ok');
    } catch (e) {
      console.error(e);
      setStatus('Failed to load audit', 'err');
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
      setStatus('Saved', 'ok');
    } catch (e) {
      console.error(e);
      setStatus('Failed to save — try again', 'err');
    } finally {
      saveBtn.disabled = false;
    }
  });

  /* ---------------- Init ---------------- */
  renderRowEditors();
  render();
