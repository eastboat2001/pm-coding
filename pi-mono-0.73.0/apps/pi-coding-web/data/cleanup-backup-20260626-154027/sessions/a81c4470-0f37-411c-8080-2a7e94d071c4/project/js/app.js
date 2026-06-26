/* ============================================================
   Main Application Controller
   ============================================================ */

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────
  const state = {
    filters: {
      Customer: [],
      Plant: [],
      DateType: 'Weekly',
      LotType: 'HVM',
      UnitType: 'NSQM',
      ProjectType: 'Overall',
    },
    selectedWeek: null,        // full week object from FinishedLotSummary
    selectedDefect: null,      // full defect object from DefectSummary
    isLoading: false,
  };

  // ── API Layer (mock, async-like) ───────────────────────────
  const API = {

    /** GET /api/filters */
    getFilters() {
      return MockDB.getFilterOptions();
    },

    /** GET /api/yield/summary */
    getSummary(filters) {
      return MockDB.getFinishedLotSummary(filters);
    },

    /** GET /api/yield/defects */
    getDefects(filters) {
      return MockDB.getDefectSummary(filters);
    },

    /** GET /api/yield/details?defectCode=XX&dateType=Weekly */
    getDefectDetails(defectCode, dateType) {
      return MockDB.getDefectDetails(defectCode, dateType);
    },

    /** Health check */
    health() {
      return { status: 'ok', timestamp: new Date().toISOString(), db: MockDB.tableStats() };
    },
  };

  // ── UI Helpers ─────────────────────────────────────────────
  function showLoading(sectionId) {
    const el = document.getElementById(sectionId);
    if (el) el.classList.add('is-loading');
  }

  function hideLoading(sectionId) {
    const el = document.getElementById(sectionId);
    if (el) el.classList.remove('is-loading');
  }

  function showEmpty(sectionId, msg) {
    const el = document.getElementById(sectionId);
    if (!el) return;
    const chart = el.querySelector('.chart-area, .kpi-grid');
    if (chart) chart.style.display = 'none';
    let emptyEl = el.querySelector('.empty-state');
    if (!emptyEl) {
      emptyEl = document.createElement('div');
      emptyEl.className = 'empty-state';
      emptyEl.innerHTML = `
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/><path d="M8 15s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>
        </svg>
        <p>${msg || 'No data available'}</p>
      `;
      el.appendChild(emptyEl);
    }
    emptyEl.style.display = 'flex';
  }

  function hideEmpty(sectionId) {
    const el = document.getElementById(sectionId);
    if (!el) return;
    const chart = el.querySelector('.chart-area, .kpi-grid');
    if (chart) chart.style.display = '';
    const emptyEl = el.querySelector('.empty-state');
    if (emptyEl) emptyEl.style.display = 'none';
  }

  function formatWeekLabel(date) {
    const d = new Date(date);
    const year = d.getFullYear();
    const startOfYear = new Date(year, 0, 1);
    const weekNum = Math.ceil(((d - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);
    return `W${String(weekNum).padStart(2, '0')}`;
  }

  // ── Filter Initialization ──────────────────────────────────
  function initFilters() {
    const filterData = API.getFilters();

    populateSelect('filterCustomer', filterData.Customer);
    populateSelect('filterPlant', filterData.Plant);
    populateSelect('filterDateType', filterData.DateType, state.filters.DateType);
    populateSelect('filterLotType', filterData.LotType, state.filters.LotType);
    populateSelect('filterUnitType', filterData.UnitType, state.filters.UnitType);
    populateSelect('filterProjectType', filterData.ProjectType, state.filters.ProjectType);

    // Bind change events
    ['filterCustomer', 'filterPlant', 'filterDateType', 'filterLotType', 'filterUnitType', 'filterProjectType'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', onFilterChange);
    });
  }

  function populateSelect(id, options, defaultVal) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = '';
    options.forEach(opt => {
      const option = document.createElement('option');
      option.value = opt;
      option.textContent = opt;
      el.appendChild(option);
    });
    if (defaultVal) el.value = defaultVal;
  }

  function onFilterChange() {
    state.filters.Customer = Array.from(document.getElementById('filterCustomer').selectedOptions).map(o => o.value);
    state.filters.Plant = Array.from(document.getElementById('filterPlant').selectedOptions).map(o => o.value);
    state.filters.DateType = document.getElementById('filterDateType').value;
    state.filters.LotType = document.getElementById('filterLotType').value;
    state.filters.UnitType = document.getElementById('filterUnitType').value;
    state.filters.ProjectType = document.getElementById('filterProjectType').value;
    state.selectedWeek = null;
    state.selectedDefect = null;
    loadDashboard();
  }

  // ── Dashboard Load ─────────────────────────────────────────
  async function loadDashboard() {
    state.isLoading = true;

    // Show loading states
    ['yieldTrendSection', 'defectParetoSection'].forEach(showLoading);
    hideLoading('yieldTrendSection');
    hideLoading('defectParetoSection');

    // Simulate async delay
    await delay(300);

    loadYieldTrend();
    loadDefectPareto();

    state.isLoading = false;
  }

  // ── Section 1: Yield Trend ─────────────────────────────────
  function loadYieldTrend() {
    const sectionId = 'yieldTrendSection';
    showLoading(sectionId);
    hideEmpty(sectionId);

    const summary = API.getSummary(state.filters);

    if (!summary || summary.length === 0) {
      showLoading(sectionId);
      showEmpty(sectionId, 'No yield data available for the selected filters.');
      return;
    }

    // Render chart
    ChartManager.renderYieldTrend('yieldTrendCanvas', summary, onWeekSelect);

    // Auto-select latest week
    if (!state.selectedWeek) {
      state.selectedWeek = summary[summary.length - 1];
    }
    renderKpiCards(state.selectedWeek);

    hideLoading(sectionId);
  }

  function onWeekSelect(weekData) {
    state.selectedWeek = weekData;
    renderKpiCards(weekData);

    // Highlight selected bar
    const chart = ChartManager.COLORS ? document.getElementById('yieldTrendCanvas') : null;
  }

  function renderKpiCards(weekData) {
    if (!weekData) return;

    const yieldEl = document.getElementById('kpiYield');
    const targetEl = document.getElementById('kpiTarget');
    const finishedEl = document.getElementById('kpiFinishedCount');
    const outputEl = document.getElementById('kpiOutput');
    const lossEl = document.getElementById('kpiLoss');
    const weekEl = document.getElementById('selectedWeekLabel');

    if (weekEl) weekEl.textContent = `${weekData.WeekLabel} (${weekData.WeekDate})`;
    if (yieldEl) yieldEl.textContent = `${weekData.Yield.toFixed(2)}%`;
    if (targetEl) targetEl.textContent = `${weekData.Target.toFixed(2)}%`;
    if (finishedEl) finishedEl.textContent = `${weekData.FinishedCount} Lots`;
    if (outputEl) outputEl.textContent = weekData.Output_NSQM.toLocaleString();
    if (lossEl) lossEl.textContent = weekData.NSQM_Loss.toLocaleString();

    // Color-code yield vs target
    if (yieldEl) {
      yieldEl.style.color = weekData.Yield >= weekData.Target ? '#0d9488' : '#c2413b';
    }
  }

  // ── Section 2: Defect Pareto ───────────────────────────────
  function loadDefectPareto() {
    const sectionId = 'defectParetoSection';
    showLoading(sectionId);
    hideEmpty(sectionId);

    const defects = API.getDefects(state.filters);

    if (!defects || defects.length === 0) {
      showLoading(sectionId);
      showEmpty(sectionId, 'No defect data available for the selected filters.');
      return;
    }

    ChartManager.renderDefectPareto('defectParetoCanvas', defects, onDefectSelect);

    // Auto-select first defect
    if (!state.selectedDefect) {
      state.selectedDefect = defects[0];
    }
    renderDefectDrilldown(state.selectedDefect);

    hideLoading(sectionId);
  }

  function onDefectSelect(defect) {
    state.selectedDefect = defect;
    renderDefectDrilldown(defect);
  }

  function renderDefectDrilldown(defect) {
    if (!defect) return;

    // Update header
    const codeEl = document.getElementById('drilldownCode');
    const nameEl = document.getElementById('drilldownName');
    const ratioEl = document.getElementById('drilldownRatio');

    if (codeEl) codeEl.textContent = defect.DefectCode;
    if (nameEl) nameEl.textContent = defect.DefectName;
    if (ratioEl) ratioEl.textContent = `${defect.AvgLossRatio.toFixed(2)}%`;

    // Get details
    const details = API.getDefectDetails(defect.DefectCode, state.filters.DateType);

    if (details && details.Trend) {
      ChartManager.renderDefectTrend('defectTrendCanvas', details.Trend);
    }

    if (details && details.Department) {
      ChartManager.renderDeptDonut('deptDonutCanvas', details.Department);
    }

    // Show drilldown
    const drilldown = document.querySelector('.drilldown-content');
    if (drilldown) drilldown.style.display = 'grid';
    const placeholder = document.querySelector('.drilldown-placeholder');
    if (placeholder) placeholder.style.display = 'none';
  }

  // ── Export ──────────────────────────────────────────────────
  function exportData() {
    const summary = API.getSummary(state.filters);
    const defects = API.getDefects(state.filters);

    let csv = 'QDM Finished Lot Yield Dashboard Export\n';
    csv += `Generated: ${new Date().toISOString()}\n`;
    csv += `Filters: Customer=${state.filters.Customer.join('|') || 'All'}, Plant=${state.filters.Plant.join('|') || 'All'}, DateType=${state.filters.DateType}, LotType=${state.filters.LotType}, UnitType=${state.filters.UnitType}, ProjectType=${state.filters.ProjectType}\n\n`;

    csv += '=== Yield Trend ===\n';
    csv += 'Week,WeekDate,Yield(%),Target(%),FinishedCount,Output_NSQM,Input_Qty,NSQM_Loss\n';
    summary.forEach(row => {
      csv += `${row.WeekLabel},${row.WeekDate},${row.Yield},${row.Target},${row.FinishedCount},${row.Output_NSQM},${row.Input_Qty},${row.NSQM_Loss}\n`;
    });

    csv += '\n=== Defect Loss Ratio ===\n';
    csv += 'DefectCode,DefectName,TotalQty,TotalInput,AvgLossRatio(%),CoreLossRatio,DepartmentCount\n';
    defects.forEach(row => {
      csv += `${row.DefectCode},"${row.DefectName}",${row.TotalQty},${row.TotalInput},${row.AvgLossRatio},${row.CoreLossRatio},${row.DeptCount}\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `QDM_Yield_Dashboard_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  // ── Utility ────────────────────────────────────────────────
  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── Footer Update Time ─────────────────────────────────────
  function updateFooterTimestamp() {
    const el = document.getElementById('lastUpdated');
    if (el) el.textContent = new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // ── Init ───────────────────────────────────────────────────
  function init() {
    initFilters();
    updateFooterTimestamp();
    loadDashboard();

    // Export button
    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) exportBtn.addEventListener('click', exportData);

    // Reset button
    const resetBtn = document.getElementById('resetBtn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        state.filters = {
          Customer: [],
          Plant: [],
          DateType: 'Weekly',
          LotType: 'HVM',
          UnitType: 'NSQM',
          ProjectType: 'Overall',
        };
        state.selectedWeek = null;
        state.selectedDefect = null;
        initFilters();
        loadDashboard();
      });
    }
  }

  // Start when DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
