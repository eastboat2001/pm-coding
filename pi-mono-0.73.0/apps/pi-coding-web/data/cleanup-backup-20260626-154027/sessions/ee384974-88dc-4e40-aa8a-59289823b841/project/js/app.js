/**
 * QDM Finished Lot Yield Dashboard — Main Application
 * Orchestrates filter state, API calls, chart rendering, and interactions.
 */

const App = (() => {
  // ─── State ─────────────────────────────────────────────────────────
  let filters = {};
  let selectedWeek = null;
  let selectedDefect = null;
  let charts = {};
  let filterOptions = null;

  // ─── DOM Helpers ───────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // Show loading on a section element
  function showSectionLoading(sectionId) {
    const section = document.getElementById(sectionId);
    if (section) {
      section.classList.add('loading');
      const spinner = section.querySelector('.loading-spinner');
      if (spinner) spinner.style.display = 'flex';
    }
  }

  function hideSectionLoading(sectionId) {
    const section = document.getElementById(sectionId);
    if (section) {
      section.classList.remove('loading');
      const spinner = section.querySelector('.loading-spinner');
      if (spinner) spinner.style.display = 'none';
    }
  }

  function showError(containerId, msg) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML =
      '<div class="empty-state">' +
      '<div class="empty-icon">⚠️</div>' +
      '<p class="empty-title">Data Unavailable</p>' +
      '<p class="empty-desc">' + (msg || 'Unable to load data. Please try again.') + '</p>' +
      '</div>';
  }

  function showEmpty(containerId, msg) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML =
      '<div class="empty-state">' +
      '<div class="empty-icon">📊</div>' +
      '<p class="empty-title">No Data</p>' +
      '<p class="empty-desc">' + (msg || 'No records match the current filters.') + '</p>' +
      '</div>';
  }

  // ─── Filter Initialization ─────────────────────────────────────────
  function initFilters() {
    filterOptions = MockDB.getFilters();
    var d = filterOptions.defaults;

    populateMultiSelect('#filterCustomer', filterOptions.customers, d.customer, 'All');
    populateMultiSelect('#filterPlant', filterOptions.plants, d.plant, 'All');
    populateSingleSelect('#filterDateType', filterOptions.dateTypes, d.dateType, 'dateType');
    populateSingleSelect('#filterLotType', filterOptions.lotTypes, d.lotType, 'lotType');
    populateSingleSelect('#filterUnitType', filterOptions.unitTypes, d.unitType, 'unitType');
    populateSingleSelect('#filterProjectType', filterOptions.projectTypes, d.projectType, 'projectType');

    filters = {
      customer: [].concat(d.customer),
      plant: [].concat(d.plant),
      dateType: d.dateType,
      lotType: d.lotType,
      unitType: d.unitType,
      projectType: d.projectType,
    };
  }

  function populateMultiSelect(selectId, options, defaultValues, allLabel) {
    var container = $(selectId);
    if (!container) return;
    var trigger = container.querySelector('.multi-select-trigger');
    var list = container.querySelector('.multi-select-list');
    if (!trigger || !list) return;

    list.innerHTML = '';
    options.forEach(function (opt) {
      var li = document.createElement('li');
      li.className = 'multi-select-item';
      var checked = defaultValues.indexOf(opt) !== -1;
      li.innerHTML =
        '<label class="multi-select-label">' +
        '<input type="checkbox" value="' + opt + '"' + (checked ? ' checked' : '') + ' />' +
        '<span>' + opt + '</span>' +
        '</label>';
      list.appendChild(li);
    });

    updateMultiSelectText(trigger, options, defaultValues, allLabel);

    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      var isOpen = list.classList.contains('open');
      closeAllDropdowns();
      if (!isOpen) list.classList.add('open');
    });

    list.addEventListener('change', function () {
      var checked = [];
      list.querySelectorAll('input:checked').forEach(function (i) { checked.push(i.value); });
      updateMultiSelectText(trigger, options, checked, allLabel);

      var filterKey = selectId.replace('#filter', '');
      filterKey = filterKey.charAt(0).toLowerCase() + filterKey.slice(1);
      filters[filterKey] = checked;
      onFilterChange();
    });
  }

  function updateMultiSelectText(trigger, allOptions, selectedValues, allLabel) {
    var label = trigger.querySelector('.multi-select-label');
    if (!label) return;
    if (selectedValues.length === 0) {
      label.textContent = 'None';
    } else if (selectedValues.length === allOptions.length) {
      label.textContent = (allLabel || 'All') + ' (' + selectedValues.length + ')';
    } else if (selectedValues.length <= 2) {
      label.textContent = selectedValues.join(', ');
    } else {
      label.textContent = selectedValues.length + ' selected';
    }
  }

  function populateSingleSelect(selectId, options, defaultValue, filterKey) {
    var select = $(selectId);
    if (!select) return;
    select.innerHTML = '';
    options.forEach(function (opt) {
      var option = document.createElement('option');
      option.value = opt;
      option.textContent = opt;
      if (opt === defaultValue) option.selected = true;
      select.appendChild(option);
    });
    select.addEventListener('change', function () {
      filters[filterKey] = select.value;
      onFilterChange();
    });
  }

  function closeAllDropdowns() {
    $$('.multi-select-list').forEach(function (l) { l.classList.remove('open'); });
  }

  // ─── Filter Change Handler ─────────────────────────────────────────
  var filterTimeout = null;
  function onFilterChange() {
    selectedWeek = null;
    selectedDefect = null;
    clearTimeout(filterTimeout);
    filterTimeout = setTimeout(function () {
      loadDashboard();
    }, 150);
  }

  // ─── Data Loading ──────────────────────────────────────────────────
  function loadDashboard() {
    loadTrendData();
    loadDefectData();
  }

  function loadTrendData() {
    showSectionLoading('trendSection');

    setTimeout(function () {
      try {
        var result = MockDB.getSummary(filters);
        if (!result.trend || result.trend.length === 0) {
          hideSectionLoading('trendSection');
          showEmpty('trendChartWrap', 'No yield data for the selected filters.');
          showEmpty('kpiPanel', 'No KPI data available.');
          return;
        }
        renderTrendChart(result.trend);
        renderKPI(result.kpi, result.lastUpdated);
        hideSectionLoading('trendSection');

        // Auto-select last week
        if (!selectedWeek && result.trend.length > 0) {
          selectedWeek = result.trend[result.trend.length - 1].weekLabel;
          updateWeekHighlight(selectedWeek);
        }
      } catch (e) {
        hideSectionLoading('trendSection');
        showError('trendChartWrap', 'Error loading trend data.');
        showError('kpiPanel', 'Error loading KPI data.');
      }
    }, 250);
  }

  function loadDefectData() {
    showSectionLoading('defectSection');

    setTimeout(function () {
      try {
        var result = MockDB.getDefects(filters);
        if (!result.pareto || result.pareto.length === 0) {
          hideSectionLoading('defectSection');
          showEmpty('paretoChartWrap', 'No defect data for the selected filters.');
          showEmpty('drilldownPanel', 'No drill-down data available.');
          return;
        }
        renderParetoChart(result.pareto, result.coreLossRatio);
        hideSectionLoading('defectSection');

        // Auto-select first defect
        if (!selectedDefect && result.pareto.length > 0) {
          selectedDefect = result.pareto[0].defectCode;
          loadDefectDrilldown(selectedDefect);
        } else if (selectedDefect) {
          loadDefectDrilldown(selectedDefect);
        }
      } catch (e) {
        hideSectionLoading('defectSection');
        showError('paretoChartWrap', 'Error loading defect data.');
        showError('drilldownPanel', 'Error loading drill-down data.');
      }
    }, 300);
  }

  function loadDefectDrilldown(code) {
    setTimeout(function () {
      try {
        var result = MockDB.getDefectDetails(code, filters);
        renderDrilldown(result);
      } catch (e) {
        showError('drilldownPanel', 'Error loading defect details.');
      }
    }, 100);
  }

  // ─── Chart: Trend (CH-01) ─────────────────────────────────────────
  function renderTrendChart(trend) {
    var container = document.getElementById('trendChartWrap');
    if (!container) return;

    var canvas = container.querySelector('canvas');
    if (!canvas) {
      container.innerHTML = '<canvas id="trendChart"></canvas>';
      canvas = document.getElementById('trendChart');
    }

    if (charts.trend) charts.trend.destroy();

    var labels = trend.map(function (t) { return t.weekLabel; });
    var yields = trend.map(function (t) { return t.yield; });
    var targets = trend.map(function (t) { return t.target; });
    var outputs = trend.map(function (t) { return t.output; });

    charts.trend = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            type: 'bar',
            label: 'Output (NSQM)',
            data: outputs,
            backgroundColor: 'rgba(37, 99, 235, 0.18)',
            borderColor: 'rgba(37, 99, 235, 0.5)',
            borderWidth: 1,
            yAxisID: 'y1',
            order: 2,
            barPercentage: 0.55,
            borderRadius: 4,
          },
          {
            type: 'line',
            label: 'Yield (%)',
            data: yields,
            borderColor: '#2563eb',
            backgroundColor: 'rgba(37, 99, 235, 0.06)',
            borderWidth: 2.5,
            pointRadius: 5,
            pointBackgroundColor: '#2563eb',
            pointBorderColor: '#ffffff',
            pointBorderWidth: 2,
            pointHoverRadius: 7,
            tension: 0.3,
            fill: true,
            yAxisID: 'y',
            order: 0,
          },
          {
            type: 'line',
            label: 'Target (%)',
            data: targets,
            borderColor: '#c2413b',
            borderWidth: 1.5,
            borderDash: [6, 4],
            pointRadius: 0,
            tension: 0.3,
            fill: false,
            yAxisID: 'y',
            order: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        onClick: function (evt) {
          if (!charts.trend) return;
          var points = charts.trend.getElementsAtEventForMode(evt, 'index', { intersect: false }, false);
          if (points.length > 0) {
            var idx = points[0].index;
            var weekLabel = trend[idx].weekLabel;
            selectedWeek = weekLabel;
            updateWeekHighlight(weekLabel);
            updateKPIFromWeek(trend[idx]);
          }
        },
        plugins: {
          legend: {
            position: 'top',
            labels: {
              usePointStyle: true,
              pointStyle: 'circle',
              padding: 16,
              font: { family: '"Arial Nova", "Plus Jakarta Sans", sans-serif', size: 12 },
            },
          },
          tooltip: {
            backgroundColor: 'rgba(17, 19, 21, 0.92)',
            titleFont: { family: '"Arial Nova", sans-serif', size: 13, weight: '600' },
            bodyFont: { family: '"Arial Nova", sans-serif', size: 12 },
            padding: 12,
            cornerRadius: 8,
            displayColors: true,
            callbacks: {
              label: function (ctx) {
                if (ctx.dataset.label === 'Output (NSQM)')
                  return 'Output: ' + ctx.raw.toLocaleString();
                return ctx.dataset.label + ': ' + ctx.raw.toFixed(2) + '%';
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { font: { family: '"Arial Nova", sans-serif', size: 11 }, color: '#647280' },
          },
          y: {
            position: 'left',
            title: { display: true, text: 'Yield (%)', font: { family: '"Arial Nova", sans-serif', size: 12 }, color: '#424a55' },
            min: 92,
            max: 100,
            grid: { color: 'rgba(217, 225, 231, 0.5)' },
            ticks: {
              font: { family: '"Arial Nova", sans-serif', size: 11 },
              color: '#647280',
              callback: function (v) { return v.toFixed(1) + '%'; },
            },
          },
          y1: {
            position: 'right',
            title: { display: true, text: 'Output (NSQM)', font: { family: '"Arial Nova", sans-serif', size: 12 }, color: '#424a55' },
            grid: { drawOnChartArea: false },
            ticks: {
              font: { family: '"Arial Nova", sans-serif', size: 11 },
              color: '#647280',
              callback: function (v) { return v >= 1000 ? (v / 1000).toFixed(0) + 'K' : v; },
            },
          },
        },
      },
    });
  }

  function updateWeekHighlight(weekLabel) {
    var indicator = $('#selectedWeekLabel');
    if (indicator) indicator.textContent = weekLabel;
  }

  function updateKPIFromWeek(weekData) {
    var kpi = {
      yield: weekData.yield,
      target: weekData.target,
      finishedCount: weekData.finishedCount,
      output: weekData.output,
      nsqmLoss: weekData.nsqmLoss,
      input: weekData.input,
      yieldPass: weekData.yield >= weekData.target,
    };
    renderKPI(kpi, MockDB.lastUpdated);
  }

  // ─── KPI Panel ─────────────────────────────────────────────────────
  function renderKPI(kpi, lastUpdated) {
    var panel = $('#kpiPanel');
    if (!panel) return;

    var yieldDiff = (kpi.yield - kpi.target).toFixed(2);
    var yieldColor = kpi.yieldPass ? '#2563eb' : '#c2413b';
    var yieldIcon = kpi.yieldPass ? '↑' : '↓';
    var lossRatio = kpi.output > 0 ? ((kpi.nsqmLoss / kpi.output) * 100).toFixed(2) : '0.00';
    var progressWidth = Math.min(Math.max(kpi.yield, 0), 100);

    panel.innerHTML =
      '<div class="kpi-card kpi-yield">' +
        '<div class="kpi-header">' +
          '<span class="kpi-label">Yield / Target</span>' +
          '<span class="kpi-badge" style="background:' + (kpi.yieldPass ? 'rgba(37,99,235,0.1)' : 'rgba(194,65,59,0.1)') + ';color:' + yieldColor + '">' +
            yieldIcon + ' ' + Math.abs(yieldDiff) + '%' +
          '</span>' +
        '</div>' +
        '<div class="kpi-value" style="color:' + yieldColor + '">' + kpi.yield.toFixed(2) + '%</div>' +
        '<div class="kpi-sub">Target: ' + kpi.target.toFixed(2) + '%</div>' +
        '<div class="kpi-progress">' +
          '<div class="kpi-progress-bar" style="width:' + progressWidth + '%;background:' + yieldColor + '"></div>' +
        '</div>' +
      '</div>' +

      '<div class="kpi-card">' +
        '<div class="kpi-header"><span class="kpi-label">Finished Count</span></div>' +
        '<div class="kpi-value">' + kpi.finishedCount.toLocaleString() + '</div>' +
        '<div class="kpi-sub">Lots</div>' +
      '</div>' +

      '<div class="kpi-card">' +
        '<div class="kpi-header"><span class="kpi-label">Output (NSQM)</span></div>' +
        '<div class="kpi-value">' + kpi.output.toLocaleString() + '</div>' +
        '<div class="kpi-sub">Input: ' + kpi.input.toLocaleString() + '</div>' +
      '</div>' +

      '<div class="kpi-card">' +
        '<div class="kpi-header"><span class="kpi-label">NSQM Loss</span></div>' +
        '<div class="kpi-value" style="color:#c2413b">' + kpi.nsqmLoss.toLocaleString() + '</div>' +
        '<div class="kpi-sub">Loss Ratio: ' + lossRatio + '%</div>' +
      '</div>' +

      '<div class="kpi-footer">' +
        '<span class="kpi-updated">Last Updated: ' + lastUpdated + '</span>' +
      '</div>';
  }

  // ─── Chart: Pareto (CH-02) ────────────────────────────────────────
  function renderParetoChart(pareto, coreLossRatio) {
    var container = document.getElementById('paretoChartWrap');
    if (!container) return;

    var canvas = container.querySelector('canvas');
    if (!canvas) {
      container.innerHTML = '<canvas id="paretoChart"></canvas>';
      canvas = document.getElementById('paretoChart');
    }

    if (charts.pareto) charts.pareto.destroy();

    var labels = pareto.map(function (p) { return p.defectCode; });
    var totalLoss = pareto.map(function (p) { return p.lossRatio; });
    var coreLoss = pareto.map(function (p, i) { return i < 5 ? p.lossRatio : 0; });

    charts.pareto = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Total Loss Ratio (%)',
            data: totalLoss,
            backgroundColor: 'rgba(194, 65, 59, 0.75)',
            borderColor: '#c2413b',
            borderWidth: 1,
            barPercentage: 0.7,
            borderRadius: 3,
          },
          {
            label: 'Core Loss Ratio (' + coreLossRatio + '%)',
            data: coreLoss,
            backgroundColor: 'rgba(37, 99, 235, 0.7)',
            borderColor: '#2563eb',
            borderWidth: 1,
            barPercentage: 0.7,
            borderRadius: 3,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        onClick: function (evt) {
          if (!charts.pareto) return;
          var points = charts.pareto.getElementsAtEventForMode(evt, 'index', { intersect: false }, false);
          if (points.length > 0) {
            var idx = points[0].index;
            selectedDefect = pareto[idx].defectCode;
            highlightDefectBar(idx);
            loadDefectDrilldown(selectedDefect);
          }
        },
        plugins: {
          legend: {
            position: 'top',
            labels: {
              usePointStyle: true,
              pointStyle: 'circle',
              padding: 16,
              font: { family: '"Arial Nova", sans-serif', size: 12 },
            },
          },
          tooltip: {
            backgroundColor: 'rgba(17, 19, 21, 0.92)',
            titleFont: { family: '"Arial Nova", sans-serif', size: 13, weight: '600' },
            bodyFont: { family: '"Arial Nova", sans-serif', size: 12 },
            padding: 12,
            cornerRadius: 8,
            callbacks: {
              afterTitle: function (ctx) {
                var idx = ctx[0].dataIndex;
                return pareto[idx].defectDesc;
              },
              label: function (ctx) {
                return ctx.dataset.label.split(' (')[0] + ': ' + ctx.raw.toFixed(2) + '%';
              },
            },
          },
        },
        scales: {
          x: {
            title: { display: true, text: 'Loss Ratio (%)', font: { family: '"Arial Nova", sans-serif', size: 12 }, color: '#424a55' },
            grid: { color: 'rgba(217, 225, 231, 0.5)' },
            ticks: {
              font: { family: '"Arial Nova", sans-serif', size: 11 },
              color: '#647280',
              callback: function (v) { return v.toFixed(1) + '%'; },
            },
          },
          y: {
            grid: { display: false },
            ticks: {
              font: { family: '"Arial Nova", sans-serif', size: 11, weight: '500' },
              color: '#111315',
            },
          },
        },
      },
    });
  }

  function highlightDefectBar(idx) {
    if (charts.pareto) {
      charts.pareto.setActiveElements([{ datasetIndex: 0, index: idx }]);
      charts.pareto.update();
    }
  }

  // ─── Drilldown Panel (CH-03) ──────────────────────────────────────
  function renderDrilldown(result) {
    var panel = $('#drilldownPanel');
    if (!panel) return;

    panel.innerHTML =
      '<div class="drilldown-header">' +
        '<h3 class="drilldown-title">' + result.defectCode + ' <span class="drilldown-desc">— ' + result.defectDesc + '</span></h3>' +
      '</div>' +
      '<div class="drilldown-charts">' +
        '<div class="drilldown-trend-wrap">' +
          '<h4 class="drilldown-subtitle">Weekly Trend</h4>' +
          '<div class="drilldown-trend-chart"><canvas id="drilldownTrendChart"></canvas></div>' +
        '</div>' +
        '<div class="drilldown-donut-wrap">' +
          '<h4 class="drilldown-subtitle">Department Attribution</h4>' +
          '<div class="drilldown-donut-chart"><canvas id="drilldownDonutChart"></canvas></div>' +
        '</div>' +
      '</div>';

    renderDrilldownTrend(result.trend, result.defectCode);
    renderDrilldownDonut(result.departments);
  }

  function renderDrilldownTrend(trend, code) {
    var canvas = document.getElementById('drilldownTrendChart');
    if (!canvas) return;

    if (charts.drilldownTrend) charts.drilldownTrend.destroy();

    charts.drilldownTrend = new Chart(canvas, {
      type: 'line',
      data: {
        labels: trend.map(function (t) { return t.weekLabel; }),
        datasets: [
          {
            label: 'Defect Qty (' + code + ')',
            data: trend.map(function (t) { return t.qty; }),
            borderColor: '#c2413b',
            backgroundColor: 'rgba(194, 65, 59, 0.08)',
            borderWidth: 2,
            pointRadius: 3.5,
            pointBackgroundColor: '#c2413b',
            pointBorderColor: '#ffffff',
            pointBorderWidth: 2,
            tension: 0.3,
            fill: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(17, 19, 21, 0.92)',
            titleFont: { family: '"Arial Nova", sans-serif', size: 12 },
            bodyFont: { family: '"Arial Nova", sans-serif', size: 12 },
            padding: 10,
            cornerRadius: 8,
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { font: { family: '"Arial Nova", sans-serif', size: 10 }, color: '#647280' },
          },
          y: {
            title: { display: true, text: 'Qty', font: { family: '"Arial Nova", sans-serif', size: 11 }, color: '#424a55' },
            grid: { color: 'rgba(217, 225, 231, 0.5)' },
            ticks: { font: { family: '"Arial Nova", sans-serif', size: 10 }, color: '#647280' },
            beginAtZero: true,
          },
        },
      },
    });
  }

  function renderDrilldownDonut(departments) {
    var canvas = document.getElementById('drilldownDonutChart');
    if (!canvas) return;

    if (charts.drilldownDonut) charts.drilldownDonut.destroy();

    var colors = ['#2563eb', '#60a5fa', '#3b82f6', '#93c5fd', '#1d4ed8', '#647280'];

    charts.drilldownDonut = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: departments.map(function (d) { return d.name; }),
        datasets: [
          {
            data: departments.map(function (d) { return d.qty; }),
            backgroundColor: departments.map(function (_, i) { return colors[i % colors.length]; }),
            borderColor: '#ffffff',
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '55%',
        plugins: {
          legend: {
            position: 'right',
            labels: {
              usePointStyle: true,
              pointStyle: 'circle',
              padding: 12,
              font: { family: '"Arial Nova", sans-serif', size: 11 },
            },
          },
          tooltip: {
            backgroundColor: 'rgba(17, 19, 21, 0.92)',
            titleFont: { family: '"Arial Nova", sans-serif', size: 12 },
            bodyFont: { family: '"Arial Nova", sans-serif', size: 12 },
            padding: 10,
            cornerRadius: 8,
            callbacks: {
              label: function (ctx) {
                var total = ctx.dataset.data.reduce(function (a, b) { return a + b; }, 0);
                var pct = total > 0 ? ((ctx.raw / total) * 100).toFixed(1) : 0;
                return ctx.label + ': ' + ctx.raw + ' (' + pct + '%)';
              },
            },
          },
        },
      },
    });
  }

  // ─── Export ─────────────────────────────────────────────────────────
  function exportToCSV() {
    var summary = MockDB.getSummary(filters);
    var defects = MockDB.getDefects(filters);

    var csv = 'QDM Finished Lot Yield Dashboard Export\n';
    csv += 'Filters: Customer=' + filters.customer.join('/') + ', Plant=' + filters.plant.join('/') + ', ';
    csv += 'DateType=' + filters.dateType + ', LotType=' + filters.lotType + ', UnitType=' + filters.unitType + ', ProjectType=' + filters.projectType + '\n';
    csv += 'Export Date: ' + new Date().toISOString().slice(0, 19) + '\n\n';

    csv += '=== Yield Trend ===\n';
    csv += 'Week,Yield (%),Target (%),Output (NSQM),Input,Finished Count,NSQM Loss\n';
    summary.trend.forEach(function (t) {
      csv += t.weekLabel + ',' + t.yield + ',' + t.target + ',' + t.output + ',' + t.input + ',' + t.finishedCount + ',' + t.nsqmLoss + '\n';
    });

    csv += '\n=== Defect Loss Ratio ===\n';
    csv += 'Defect Code,Description,Quantity,Loss Ratio (%)\n';
    defects.pareto.forEach(function (p) {
      csv += p.defectCode + ',' + p.defectDesc + ',' + p.defectQty + ',' + p.lossRatio + '\n';
    });

    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'QDM_Yield_Dashboard_' + filters.dateType + '_' + filters.lotType + '_' + new Date().toISOString().slice(0, 10) + '.csv';
    link.click();
  }

  // ─── Initialization ────────────────────────────────────────────────
  function init() {
    // Set last updated in header
    var updateEl = $('#lastUpdated');
    if (updateEl) updateEl.textContent = 'Updated: ' + MockDB.lastUpdated;

    var footerSync = $('#footerLastSync');
    if (footerSync) footerSync.textContent = ' | Last Sync: ' + MockDB.lastUpdated;

    initFilters();
    loadDashboard();

    // Export button
    var exportBtn = $('#btnExport');
    if (exportBtn) exportBtn.addEventListener('click', exportToCSV);

    // Refresh button
    var refreshBtn = $('#refreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { loadDashboard(); });

    // Close dropdowns on outside click
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.multi-select')) {
        closeAllDropdowns();
      }
    });

    // Mobile menu toggle
    var menuToggle = $('#menuToggle');
    var sidebar = $('#filterSidebar');
    if (menuToggle && sidebar) {
      menuToggle.addEventListener('click', function () {
        sidebar.classList.toggle('open');
      });
    }
  }

  return { init: init };
})();

// Boot
document.addEventListener('DOMContentLoaded', function () {
  App.init();
});
