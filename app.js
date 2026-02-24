/* ===============================================================
   Ressourcenplanung – App Logic
   =============================================================== */

'use strict';

// ───────────────────────── Constants ─────────────────────────

const PROJECT_COLORS = [
  '#7c6dfa', '#f472b6', '#34d399', '#fb923c',
  '#60a5fa', '#a78bfa', '#f87171', '#4ade80',
  '#fbbf24', '#38bdf8', '#e879f9', '#a3e635'
];

const VACATION_ID = '__urlaub__';
const VACATION_COLOR = '#64748b';
const SICK_ID = '__krank__';
const SICK_COLOR = '#ef4444';
const ADMIN_ID = '__admin__';
const ADMIN_COLOR = '#f59e0b';

const DAY_NAMES = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag'];
const DAY_SHORTS = ['Mo', 'Di', 'Mi', 'Do', 'Fr'];
const MONTH_NAMES = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

// ───────────────────────── State ─────────────────────────────

let state = {
  employees: [],
  projects: [],
  tasks: [],
  currentMonday: getMonday(new Date()),
  viewWeeks: 1  // 1 or 2
};

// Selection state for multi-day drag
let selectionState = { active: false, empId: null, startDate: null, endDate: null, cells: [] };

// ───────────────────────── Persistence ───────────────────────

function saveState() {
  localStorage.setItem('rp_state', JSON.stringify(state));
}

function loadState() {
  const raw = localStorage.getItem('rp_state');
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      state.employees = parsed.employees || [];
      state.projects = parsed.projects || [];
      state.tasks = parsed.tasks || [];
      state.viewWeeks = parsed.viewWeeks || 1;
      if (parsed.currentMonday) {
        state.currentMonday = new Date(parsed.currentMonday);
      }
    } catch (e) { /* ignore corrupt data */ }
  }
}

// ───────────────────────── Date Helpers ──────────────────────

function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day === 0) ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getWeekDays(monday, weeks) {
  const numDays = (weeks || state.viewWeeks || 1) * 5;
  return Array.from({ length: numDays }, (_, i) => {
    const d = new Date(monday);
    // Skip weekends: add extra 2 days per full week
    const week = Math.floor(i / 5);
    const dayInWeek = i % 5;
    d.setDate(d.getDate() + week * 7 + dayInWeek);
    return d;
  });
}

function dateToKey(date) {
  // Use local date parts to avoid UTC timezone shift (toISOString uses UTC)
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function keyToDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function getKW(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function isToday(date) {
  const today = new Date();
  return date.toDateString() === today.toDateString();
}

function formatShortDate(date) {
  return `${date.getDate()}. ${MONTH_NAMES[date.getMonth()].slice(0, 3)}`;
}

// ───────────────────────── ID Generator ──────────────────────

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Count weekdays between two date keys (inclusive)
function countWeekdays(startKey, endKey) {
  let count = 0;
  const cur = keyToDate(startKey);
  const last = keyToDate(endKey);
  while (cur <= last) {
    const dow = cur.getDay();
    if (dow >= 1 && dow <= 5) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// Total booked days for a project (across ALL tasks), optionally excluding a task ID
function getProjectBookedDays(projectId, excludeTaskId) {
  let total = 0;
  state.tasks.forEach(t => {
    if (t.projectId !== projectId) return;
    if (excludeTaskId && t.id === excludeTaskId) return;
    total += countWeekdays(t.startDate, t.endDate) * t.budget;
  });
  return total;
}
// ───────────────────────── Getters ───────────────────────────

function getProject(id) { return state.projects.find(p => p.id === id); }
function getEmployee(id) { return state.employees.find(e => e.id === id); }

function getTasksForEmployeeInWeek(employeeId, weekDays) {
  const start = dateToKey(weekDays[0]);
  const end = dateToKey(weekDays[weekDays.length - 1]);
  return state.tasks.filter(t =>
    t.employeeId === employeeId &&
    t.endDate >= start &&
    t.startDate <= end
  );
}

function getTasksForCell(employeeId, dayKey) {
  return state.tasks.filter(t =>
    t.employeeId === employeeId &&
    t.startDate <= dayKey &&
    t.endDate >= dayKey
  );
}

// How many week-days does a task span (clamped to Mon–Fri of given week)?
function taskDaysInWeek(task, weekDays) {
  const wStart = dateToKey(weekDays[0]);
  const wEnd = dateToKey(weekDays[weekDays.length - 1]);
  const clampedStart = task.startDate < wStart ? wStart : task.startDate;
  const clampedEnd = task.endDate > wEnd ? wEnd : task.endDate;
  // Count weekdays between clampedStart and clampedEnd
  let count = 0;
  const cur = keyToDate(clampedStart);
  const last = keyToDate(clampedEnd);
  while (cur <= last) {
    const dow = cur.getDay();
    if (dow >= 1 && dow <= 5) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// Utilization calculation
function calcUtilization(employeeId, weekDays) {
  const emp = getEmployee(employeeId);
  if (!emp) return { bookedH: 0, totalH: 0, pct: 0, vacationH: 0 };

  const hoursPerDay = emp.weeklyHours / 5;
  const tasks = getTasksForEmployeeInWeek(employeeId, weekDays);

  let bookedDays = 0;
  let vacationDays = 0;
  tasks.forEach(task => {
    const proj = getProject(task.projectId);
    const days = taskDaysInWeek(task, weekDays);
    if (proj && proj.isVacation) {
      vacationDays += days * task.budget;
    } else {
      bookedDays += days * task.budget;
    }
  });

  const vacationH = Math.round(vacationDays * hoursPerDay * 10) / 10;
  const bookedH = Math.round(bookedDays * hoursPerDay * 10) / 10;
  const totalH = Math.round((emp.weeklyHours - vacationH) * 10) / 10;
  const pct = totalH > 0 ? Math.round((bookedH / totalH) * 100) : 0;
  return { bookedH, totalH, pct, vacationH };
}

// ───────────────────────── Render Matrix ─────────────────────

function render() {
  const container = document.getElementById('matrixContainer');
  const weekDays = getWeekDays(state.currentMonday);

  // Update week label
  const kw1 = getKW(state.currentMonday);
  const year = state.currentMonday.getFullYear();
  if (state.viewWeeks === 2) {
    const monday2 = new Date(state.currentMonday);
    monday2.setDate(monday2.getDate() + 7);
    const kw2 = getKW(monday2);
    const m1 = MONTH_NAMES[weekDays[0].getMonth()];
    const m2 = MONTH_NAMES[weekDays[weekDays.length - 1].getMonth()];
    const monthStr = m1 === m2 ? m1 : `${m1} / ${m2}`;
    document.getElementById('weekLabel').textContent = `KW ${kw1}–${kw2} · ${monthStr} ${year}`;
  } else {
    const m1 = MONTH_NAMES[weekDays[0].getMonth()];
    const m2 = MONTH_NAMES[weekDays[4].getMonth()];
    const monthStr = m1 === m2 ? m1 : `${m1} / ${m2}`;
    document.getElementById('weekLabel').textContent = `KW ${kw1} · ${monthStr} ${year}`;
  }

  if (state.employees.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">👥</div>
        <p>Noch keine Mitarbeiter angelegt.<br>Starte damit, Mitarbeiter und Projekte hinzuzufügen.</p>
        <button class="btn btn-primary" onclick="openModal('employeeModal')">Mitarbeiter hinzufügen</button>
      </div>`;
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'matrix-wrapper';

  // Use shorter day names for 2-week view
  const useShort = state.viewWeeks === 2;

  // Build HTML
  let html = `<table class="matrix${useShort ? ' compact' : ''}">
    <colgroup>
      <col class="col-employee">
      ${weekDays.map(() => `<col class="col-day">`).join('')}
      ${state.viewWeeks === 1 ? '<col class="col-util">' : ''}
    </colgroup>
    <thead>
      <tr>
        <th class="th-employee">Mitarbeiter</th>
        ${weekDays.map(d => {
    const dayLabel = useShort ? DAY_SHORTS[d.getDay() - 1] : DAY_NAMES[d.getDay() - 1];
    return `<th class="th-day">
            <div class="day-name">${dayLabel}</div>
            <div class="day-date">${formatShortDate(d)}</div>
          </th>`;
  }).join('')}
        ${state.viewWeeks === 1 ? '<th class="th-util">Auslastung</th>' : ''}
      </tr>
    </thead>
    <tbody>`;

  state.employees.forEach(emp => {
    html += `<tr><td class="cell-employee">
        <div class="employee-name">${escHtml(emp.name)}</div>
        <div class="employee-hours">${emp.weeklyHours}h / Woche</div>
      </td>`;

    // Render each day cell — no colspan, every day gets its own <td>
    const weekStart = dateToKey(weekDays[0]);
    const weekEnd = dateToKey(weekDays[weekDays.length - 1]);

    weekDays.forEach((day, di) => {
      const dayKey = dateToKey(day);
      const cellTasks = getTasksForCell(emp.id, dayKey);
      const todayCls = isToday(day) ? ' today' : '';

      const taskHtml = cellTasks.map(t => {
        const proj = getProject(t.projectId);
        const color = proj ? proj.color : '#555';
        const projName = proj ? proj.name : '?';
        const budgetLabel = t.budget === 0.5 ? '½ Tag' : '1 Tag';

        // Determine multi-day CSS class
        const effectiveStart = t.startDate < weekStart ? weekStart : t.startDate;
        const effectiveEnd = t.endDate > weekEnd ? weekEnd : t.endDate;
        const isMultiDay = effectiveStart !== effectiveEnd;
        let mdClass = '';
        if (isMultiDay) {
          if (dayKey === effectiveStart) mdClass = ' multi-day-start';
          else if (dayKey === effectiveEnd) mdClass = ' multi-day-end';
          else mdClass = ' multi-day-mid';
        }

        // Only show label on first day of multi-day task
        const showLabel = !isMultiDay || dayKey === effectiveStart;
        const noteHtml = showLabel
          ? (t.note ? `<div class="task-budget">${escHtml(t.note)}</div>` : `<div class="task-budget">${budgetLabel}</div>`)
          : '';
        const nameHtml = showLabel ? `<div class="task-name">${escHtml(projName)}</div>` : '';

        const budgetClass = t.budget === 0.5 ? ' budget-half' : ' budget-full';

        return `<div class="task-card${mdClass}${budgetClass}"
            style="background:${color}cc;border-left-color:${color}"
            data-id="${t.id}">
            ${nameHtml}${noteHtml}
          </div>`;
      }).join('');

      html += `<td class="cell-day${todayCls}"
          data-emp="${emp.id}"
          data-date="${dayKey}"
          onmousedown="cellMouseDown(event,'${emp.id}','${dayKey}')"
          onmouseover="cellMouseOver(event,'${emp.id}','${dayKey}')"
          onmouseup="cellMouseUp(event,'${emp.id}','${dayKey}')">
          ${taskHtml}
          <button class="add-task-btn" onclick="openAddTask(event,'${emp.id}','${dayKey}')">+ Aufgabe</button>
        </td>`;
    });

    if (state.viewWeeks === 1) {
      const util = calcUtilization(emp.id, weekDays);
      let cls = 'util-green';
      if (util.pct > 100) cls = 'util-red';
      else if (util.pct > 79) cls = 'util-yellow';
      const barWidth = Math.min(util.pct, 100);

      html += `<td class="cell-util ${cls}">
          <div class="util-hours">${util.bookedH} / ${util.totalH}h</div>
          <div class="util-bar-wrap">
            <div class="util-bar" style="width:${barWidth}%"></div>
          </div>
          <div class="util-pct">${util.pct}%</div>
          ${util.vacationH > 0 ? `<div style="font-size:10px;color:var(--text-muted);margin-top:3px">⊘ ${util.vacationH}h nicht buchbar</div>` : ''}
        </td>`;
    }
    html += '</tr>';
  });

  html += '</tbody></table>';
  wrapper.innerHTML = html;
  container.innerHTML = '';
  container.appendChild(wrapper);
}

// ───────────────────────── Cell Selection ────────────────────

function clearSelection() {
  selectionState.cells.forEach(cell => cell.classList.remove('cell-selected'));
  selectionState = { active: false, empId: null, startDate: null, endDate: null, cells: [] };
}

function highlightSelection() {
  // Remove old highlights
  document.querySelectorAll('.cell-selected').forEach(c => c.classList.remove('cell-selected'));
  if (!selectionState.empId || !selectionState.startDate) return;

  const minDate = selectionState.startDate < selectionState.endDate ? selectionState.startDate : selectionState.endDate;
  const maxDate = selectionState.startDate > selectionState.endDate ? selectionState.startDate : selectionState.endDate;

  document.querySelectorAll('.cell-day').forEach(cell => {
    if (cell.dataset.emp === selectionState.empId &&
      cell.dataset.date >= minDate && cell.dataset.date <= maxDate) {
      cell.classList.add('cell-selected');
    }
  });
}

function cellMouseDown(e, empId, dayKey) {
  // If clicked on task card → edit
  const card = e.target.closest('.task-card');
  if (card) { openEditTask(card.dataset.id); return; }
  if (e.target.closest('.add-task-btn')) return;

  e.preventDefault(); // prevent text selection
  selectionState = { active: true, empId, startDate: dayKey, endDate: dayKey, cells: [] };
  highlightSelection();
}

function cellMouseOver(e, empId, dayKey) {
  if (!selectionState.active) return;
  if (empId !== selectionState.empId) return; // same employee only
  selectionState.endDate = dayKey;
  highlightSelection();
}

function cellMouseUp(e, empId, dayKey) {
  if (!selectionState.active) return;
  selectionState.active = false;

  // If clicked on task card, the mouseDown already handled it
  const card = e.target.closest('.task-card');
  if (card) { clearSelection(); return; }
  if (e.target.closest('.add-task-btn')) { clearSelection(); return; }

  const minDate = selectionState.startDate < selectionState.endDate ? selectionState.startDate : selectionState.endDate;
  const maxDate = selectionState.startDate > selectionState.endDate ? selectionState.startDate : selectionState.endDate;

  // Open add task with selected range
  const fakeEvent = { stopPropagation: () => { } };
  taskContext = { editId: null, empId: selectionState.empId, dayKey: minDate };
  selectedBudget = 0.5;
  document.getElementById('taskModalTitle').textContent = 'Aufgabe hinzufügen';
  document.getElementById('btnDeleteTask').style.display = 'none';
  document.getElementById('taskNote').value = '';
  populateTaskModal(selectionState.empId, minDate, maxDate);
  selectBudget(0.5);
  openModal('taskModal');
  clearSelection();
}

// Global mouseup handler to cancel selection if released outside table
document.addEventListener('mouseup', () => {
  if (selectionState.active) {
    selectionState.active = false;
    clearSelection();
  }
});

// ───────────────────────── Task Modal ────────────────────────

let taskContext = { editId: null, empId: null, dayKey: null };
let selectedBudget = 0.5;

function openAddTask(e, empId, dayKey) {
  e.stopPropagation();
  taskContext = { editId: null, empId, dayKey };
  selectedBudget = 0.5;

  document.getElementById('taskModalTitle').textContent = 'Aufgabe hinzufügen';
  document.getElementById('btnDeleteTask').style.display = 'none';
  document.getElementById('taskNote').value = '';

  populateTaskModal(empId, dayKey, dayKey);
  selectBudget(0.5);
  openModal('taskModal');
}

function openEditTask(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  taskContext = { editId: taskId, empId: task.employeeId, dayKey: task.startDate };
  selectedBudget = task.budget;

  document.getElementById('taskModalTitle').textContent = 'Aufgabe bearbeiten';
  document.getElementById('btnDeleteTask').style.display = 'inline-flex';
  document.getElementById('taskNote').value = task.note || '';

  populateTaskModal(task.employeeId, task.startDate, task.endDate, task.projectId);
  selectBudget(task.budget);
  openModal('taskModal');
}

function populateTaskModal(empId, startKey, endKey, projectId) {
  // Project dropdown
  const sel = document.getElementById('taskProject');
  sel.innerHTML = state.projects.length === 0
    ? '<option value="">— Kein Projekt vorhanden —</option>'
    : state.projects.map(p => `<option value="${p.id}" ${p.id === projectId ? 'selected' : ''}>${escHtml(p.name)}</option>`).join('');

  // Date inputs (unrestricted range)
  const startInput = document.getElementById('taskStart');
  const endInput = document.getElementById('taskEnd');
  const defaultDay = startKey || dateToKey(getWeekDays(state.currentMonday)[0]);
  startInput.value = defaultDay;
  endInput.value = endKey || defaultDay;

  // Keep end >= start
  startInput.onchange = () => {
    if (endInput.value < startInput.value) endInput.value = startInput.value;
  };
  endInput.onchange = () => {
    if (endInput.value < startInput.value) startInput.value = endInput.value;
  };

  // Budget info display
  const updateBudgetInfo = () => {
    let infoEl = document.getElementById('taskBudgetInfo');
    if (!infoEl) {
      infoEl = document.createElement('div');
      infoEl.id = 'taskBudgetInfo';
      infoEl.style.cssText = 'font-size:12px;padding:8px 12px;border-radius:6px;margin-bottom:12px;';
      sel.parentElement.after(infoEl);
    }
    const proj = getProject(sel.value);
    if (!proj || !proj.budgetDays || proj.budgetDays <= 0) {
      infoEl.style.display = 'none';
      return;
    }
    const booked = getProjectBookedDays(proj.id, taskContext.editId);
    const remaining = proj.budgetDays - booked;
    if (remaining <= 0) {
      infoEl.style.display = 'block';
      infoEl.style.background = 'rgba(248,113,113,0.12)';
      infoEl.style.color = 'var(--red)';
      infoEl.textContent = `⚠ Budget erschöpft: ${booked} / ${proj.budgetDays} Tage gebucht (${Math.abs(remaining)} überbucht)`;
    } else {
      infoEl.style.display = 'block';
      infoEl.style.background = 'rgba(74,222,128,0.1)';
      infoEl.style.color = 'var(--green)';
      infoEl.textContent = `✓ ${remaining} von ${proj.budgetDays} Tagen frei (${booked} gebucht)`;
    }
  };
  sel.onchange = updateBudgetInfo;
  updateBudgetInfo();
}

function selectBudget(val) {
  selectedBudget = val;
  document.getElementById('budgetHalf').classList.toggle('selected', val === 0.5);
  document.getElementById('budgetFull').classList.toggle('selected', val === 1);
}

document.getElementById('budgetHalf').addEventListener('click', () => selectBudget(0.5));
document.getElementById('budgetFull').addEventListener('click', () => selectBudget(1));

document.getElementById('btnSaveTask').addEventListener('click', () => {
  const projectId = document.getElementById('taskProject').value;
  const startDate = document.getElementById('taskStart').value;
  const endDate = document.getElementById('taskEnd').value;
  const note = document.getElementById('taskNote').value.trim();

  if (!projectId) { toast('Bitte ein Projekt auswählen.', 'error'); return; }
  if (!startDate || !endDate) { toast('Bitte Zeitraum wählen.', 'error'); return; }
  if (endDate < startDate) { toast('Enddatum muss nach Startdatum liegen.', 'error'); return; }



  if (taskContext.editId) {
    // Edit
    const task = state.tasks.find(t => t.id === taskContext.editId);
    if (task) { task.projectId = projectId; task.startDate = startDate; task.endDate = endDate; task.budget = selectedBudget; task.note = note; }
  } else {
    // New
    state.tasks.push({
      id: uid(), projectId,
      employeeId: taskContext.empId,
      startDate, endDate,
      budget: selectedBudget,
      note
    });
  }

  saveState();
  closeModal('taskModal');
  render();
  toast('Aufgabe gespeichert ✓', 'success');
});

document.getElementById('btnDeleteTask').addEventListener('click', () => {
  if (!taskContext.editId) return;
  state.tasks = state.tasks.filter(t => t.id !== taskContext.editId);
  saveState();
  closeModal('taskModal');
  render();
  toast('Aufgabe gelöscht.', 'success');
});

function getDatesInRange(startKey, endKey) {
  const result = [];
  const cur = keyToDate(startKey);
  const last = keyToDate(endKey);
  while (cur <= last) {
    const dow = cur.getDay();
    if (dow >= 1 && dow <= 5) result.push(dateToKey(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return result;
}

// ───────────────────────── Employee Modal ────────────────────

function renderEmployeeList() {
  const list = document.getElementById('employeeList');
  if (state.employees.length === 0) {
    list.innerHTML = '<p style="color:var(--text-muted);font-size:13px">Noch keine Mitarbeiter.</p>';
    return;
  }
  list.innerHTML = state.employees.map(e => `
    <div class="list-item">
      <div class="list-item-info">
        <div class="list-item-name">${escHtml(e.name)}</div>
        <div class="list-item-sub">${e.weeklyHours}h / Woche</div>
      </div>
      <div class="list-item-actions">
        <button class="btn-icon" onclick="editEmployee('${e.id}')" title="Bearbeiten">✏️</button>
        <button class="btn-icon danger" onclick="deleteEmployee('${e.id}')" title="Löschen">🗑</button>
      </div>
    </div>`).join('');
}

function editEmployee(id) {
  const emp = getEmployee(id);
  if (!emp) return;
  const newName = prompt('Name:', emp.name);
  if (newName === null) return;
  if (!newName.trim()) { toast('Name darf nicht leer sein.', 'error'); return; }
  const newHours = prompt('Wochenstunden:', emp.weeklyHours);
  if (newHours === null) return;
  const h = parseInt(newHours, 10);
  if (!h || h < 1 || h > 60) { toast('Ungültige Stundenzahl (1–60).', 'error'); return; }
  emp.name = newName.trim();
  emp.weeklyHours = h;
  saveState();
  renderEmployeeList();
  render();
  toast('Mitarbeiter aktualisiert.', 'success');
}

document.getElementById('btnManageEmployees').addEventListener('click', () => {
  renderEmployeeList();
  document.getElementById('newEmpName').value = '';
  document.getElementById('newEmpHours').value = '40';
  openModal('employeeModal');
});

document.getElementById('btnAddEmployee').addEventListener('click', () => {
  const name = document.getElementById('newEmpName').value.trim();
  const hours = parseInt(document.getElementById('newEmpHours').value, 10);
  if (!name) { toast('Bitte Namen eingeben.', 'error'); return; }
  if (!hours || hours < 1) { toast('Ungültige Stundenzahl.', 'error'); return; }
  state.employees.push({ id: uid(), name, weeklyHours: hours });
  saveState();
  document.getElementById('newEmpName').value = '';
  renderEmployeeList();
  render();
  toast(`${name} hinzugefügt.`, 'success');
});

function deleteEmployee(id) {
  const emp = getEmployee(id);
  if (!emp) return;
  if (!confirm(`Mitarbeiter „${emp.name}" und alle zugehörigen Aufgaben löschen?`)) return;
  state.employees = state.employees.filter(e => e.id !== id);
  state.tasks = state.tasks.filter(t => t.employeeId !== id);
  saveState();
  renderEmployeeList();
  render();
  toast('Mitarbeiter gelöscht.', 'success');
}

// ───────────────────────── Project Modal ─────────────────────

let selectedColor = PROJECT_COLORS[0];

function renderProjectList() {
  const list = document.getElementById('projectList');
  if (state.projects.length === 0) {
    list.innerHTML = '<p style="color:var(--text-muted);font-size:13px">Noch keine Projekte.</p>';
    return;
  }
  list.innerHTML = state.projects.map(p => {
    const vacLabel = p.isVacation ? ' <span style="color:var(--text-muted);font-size:11px">(System)</span>' : '';
    const delBtn = p.isVacation ? '' : `<button class="btn-icon danger" onclick="deleteProject('${p.id}')" title="Löschen">🗑</button>`;
    const booked = getProjectBookedDays(p.id);
    let budgetInfo = '';
    if (p.budgetDays && p.budgetDays > 0) {
      const remaining = p.budgetDays - booked;
      const cls = remaining < 0 ? 'color:var(--red)' : 'color:var(--text-muted)';
      budgetInfo = `<div class="list-item-sub">${booked} / ${p.budgetDays} Tage gebucht · <span style="${cls}">${remaining >= 0 ? remaining + ' frei' : Math.abs(remaining) + ' überbucht'}</span></div>`;
    } else if (!p.isVacation) {
      budgetInfo = `<div class="list-item-sub">${booked} Tage gebucht · kein Budget</div>`;
    }
    return `<div class="list-item">
      <div class="color-dot" style="background:${p.color}"></div>
      <div class="list-item-info">
        <div class="list-item-name">${escHtml(p.name)}${vacLabel}</div>
        ${budgetInfo}
      </div>
      <div class="list-item-actions">
        ${!p.isVacation ? `<button class="btn-icon" onclick="editProjectBudget('${p.id}')" title="Budget bearbeiten">✏️</button>` : ''}
        ${delBtn}
      </div>
    </div>`;
  }).join('');
}

function renderColorSwatches() {
  const wrap = document.getElementById('colorSwatches');
  wrap.innerHTML = PROJECT_COLORS.map(c => `
    <div class="color-swatch ${c === selectedColor ? 'selected' : ''}"
         style="background:${c}"
         onclick="selectColor('${c}')"></div>`).join('');
}

function selectColor(c) {
  selectedColor = c;
  renderColorSwatches();
}

document.getElementById('btnManageProjects').addEventListener('click', () => {
  renderProjectList();
  selectedColor = PROJECT_COLORS[0];
  renderColorSwatches();
  document.getElementById('newProjName').value = '';
  openModal('projectModal');
});

document.getElementById('btnAddProject').addEventListener('click', () => {
  const name = document.getElementById('newProjName').value.trim();
  if (!name) { toast('Bitte Projektname eingeben.', 'error'); return; }
  const budgetInput = document.getElementById('newProjBudget').value.trim();
  const budgetDays = budgetInput ? parseFloat(budgetInput) : null;
  if (budgetInput && (isNaN(budgetDays) || budgetDays < 0.5)) {
    toast('Budget muss mindestens 0,5 Tage sein.', 'error'); return;
  }
  state.projects.push({ id: uid(), name, color: selectedColor, budgetDays });
  saveState();
  document.getElementById('newProjName').value = '';
  document.getElementById('newProjBudget').value = '';
  const usedColors = state.projects.map(p => p.color);
  selectedColor = PROJECT_COLORS.find(c => !usedColors.includes(c)) || PROJECT_COLORS[0];
  renderProjectList();
  renderColorSwatches();
  toast(`Projekt „${name}" erstellt.`, 'success');
});

function editProjectBudget(id) {
  const proj = getProject(id);
  if (!proj) return;
  const current = proj.budgetDays || '';
  const input = prompt(`Budget für „${proj.name}" in Tagen (leer = kein Budget):`, current);
  if (input === null) return; // cancelled
  if (input.trim() === '') {
    proj.budgetDays = null;
  } else {
    const val = parseFloat(input.replace(',', '.'));
    if (isNaN(val) || val < 0.5) { toast('Budget muss mindestens 0,5 Tage sein.', 'error'); return; }
    proj.budgetDays = val;
  }
  saveState();
  renderProjectList();
  toast('Budget aktualisiert.', 'success');
}

function deleteProject(id) {
  const proj = getProject(id);
  if (!proj) return;
  if (proj.isVacation) { toast('Urlaub kann nicht gelöscht werden.', 'error'); return; }
  if (!confirm(`Projekt '${proj.name}' und alle zugehörigen Aufgaben löschen?`)) return;
  state.projects = state.projects.filter(p => p.id !== id);
  state.tasks = state.tasks.filter(t => t.projectId !== id);
  saveState();
  renderProjectList();
  render();
  toast('Projekt gelöscht.', 'success');
}

// ───────────────────────── Week Navigation ───────────────────

document.getElementById('prevWeek').addEventListener('click', () => {
  state.currentMonday.setDate(state.currentMonday.getDate() - 7);
  saveState();
  render();
  populateMonthPicker();
});

document.getElementById('nextWeek').addEventListener('click', () => {
  state.currentMonday.setDate(state.currentMonday.getDate() + 7);
  saveState();
  render();
  populateMonthPicker();
});

document.getElementById('btnToday').addEventListener('click', () => {
  state.currentMonday = getMonday(new Date());
  saveState();
  render();
  populateMonthPicker();
});

// Month picker
function populateMonthPicker() {
  const picker = document.getElementById('monthPicker');
  const now = new Date();
  const options = [];
  for (let offset = -12; offset <= 12; offset++) {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
    options.push(`<option value="${key}">${label}</option>`);
  }
  picker.innerHTML = options.join('');
  const cur = `${state.currentMonday.getFullYear()}-${String(state.currentMonday.getMonth() + 1).padStart(2, '0')}`;
  picker.value = cur;
}

document.getElementById('monthPicker').addEventListener('change', (e) => {
  const [year, month] = e.target.value.split('-').map(Number);
  const firstDay = new Date(year, month - 1, 1);
  state.currentMonday = getMonday(firstDay);
  saveState();
  render();
});

// View toggle (1W / 2W)
document.getElementById('btnToggleWeeks').addEventListener('click', () => {
  state.viewWeeks = state.viewWeeks === 1 ? 2 : 1;
  document.getElementById('btnToggleWeeks').textContent = state.viewWeeks === 1 ? '1W' : '2W';
  saveState();
  render();
  populateMonthPicker();
});

// ───────────────────────── Modal helpers ─────────────────────

function openModal(id) {
  document.getElementById(id).classList.add('open');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

// Close buttons
document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => closeModal(btn.dataset.close));
});

// Click overlay to close
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeModal(overlay.id);
  });
});

// ───────────────────────── Toast ─────────────────────────────

function toast(msg, type = '') {
  const c = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ───────────────────────── Utilities ─────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ───────────────────────── Init ──────────────────────────────

function ensureSystemProjects() {
  // Urlaub
  if (!state.projects.find(p => p.id === VACATION_ID)) {
    state.projects.unshift({
      id: VACATION_ID, name: 'Urlaub', color: VACATION_COLOR, isVacation: true
    });
    saveState();
  }
  const vp = state.projects.find(p => p.id === VACATION_ID);
  if (vp && !vp.isVacation) { vp.isVacation = true; saveState(); }

  // Krank
  if (!state.projects.find(p => p.id === SICK_ID)) {
    // Insert after Urlaub (position 1)
    const idx = state.projects.findIndex(p => p.id === VACATION_ID);
    state.projects.splice(idx + 1, 0, {
      id: SICK_ID, name: 'Krank', color: SICK_COLOR, isVacation: true
    });
    saveState();
  }
  const sp = state.projects.find(p => p.id === SICK_ID);
  if (sp && !sp.isVacation) { sp.isVacation = true; saveState(); }

  // Admin
  if (!state.projects.find(p => p.id === ADMIN_ID)) {
    const idx = state.projects.findIndex(p => p.id === SICK_ID);
    state.projects.splice(idx + 1, 0, {
      id: ADMIN_ID, name: 'Admin', color: ADMIN_COLOR, isVacation: true
    });
    saveState();
  }
  const ap = state.projects.find(p => p.id === ADMIN_ID);
  if (ap && !ap.isVacation) { ap.isVacation = true; saveState(); }
}

loadState();
ensureSystemProjects();
populateMonthPicker();
document.getElementById('btnToggleWeeks').textContent = state.viewWeeks === 1 ? '1W' : '2W';
render();
