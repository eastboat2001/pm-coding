/**
 * QDM Finished Lot Yield Dashboard — Main Application
 * Chart rendering, filter logic, interactions, export
 */
(function () {
  'use strict';

  // ========================================================
  // State
  // ========================================================
  const state = {
    filters: {
      customer: 'ALL',
      plant: 'ALL',
      dateType: 'Weekly',
      lotType: 'HVM',
      unitType: 'NSQM',
      projectType: 'Overall'
    },
    selectedWeekIndex: -1, // -1 means all weeks / latest
    selectedDefectCode: null
  };

  // Chart instances
  let chartTrend = null;
  let chartPareto = null;
  let chartDefectTrend = null;
  let chartDeptDonut = null;

  // ========================================================
  // Initialization
  // ========================================================
  document.addEventListener('DOMContentLoaded', init);

  function init() {
    document.getElementById('lastUpdated').textContent = DashboardData.lastUpdated;
    initFilters();
    initCharts();
    renderAll();
    initExport();
    initResetButton();
    window.addEventListener('resize', debounce(handleResize, 200));
  }

  // ========================================================
  // Filter System
  // ========================================================
  function initFilters() {
    document.querySelectorAll('.dc-select-wrap').forEach(wrap => {
      const filterKey = wrap.dataset.filter;
      const optionsData = getFilterOptions(filterKey);
      const isMulti = !wrap.querySelector('.dc-single');
      const optionsContainer = wrap.querySelector('.dc-select-options');
      const btn = wrap.querySelector('.dc-select-btn');
      const textSpan = wrap.querySelector('.dc-select-text');

      // Render options
      renderFilterOptions(optionsContainer, optionsData, isMulti, filterKey);

      // Toggle dropdown
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllDropdowns();
        wrap.classList.toggle('open');
        if (wrap.classList.contains('open')) {
          const searchInput = wrap.querySelector('.dc-search-input');
          if (searchInput) { searchInput.value = ''; searchInput.focus(); filterVisibleOptions(wrap, ''); }
        }
      });

      // Search
      const searchInput = wrap.querySelector('.dc-search-input');
      if (searchInput) {
        searchInput.addEventListener('input', () => filterVisibleOptions(wrap, searchInput.value));
        searchInput.addEventListener('click', e => e.stopPropagation());
      }

      // Select All / Clear
      if (isMulti) {
        const allBtn = wrap.querySelector('.dc-opt-all');
        const clearBtn = wrap.querySelector('.dc-opt-clear');
        if (allBtn) {
          allBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            state.filters[filterKey] = 'ALL';
            updateFilterDisplay(wrap, filterKey, isMulti);
            closeAllDropdowns();
            renderAll();
          });
        }
        if (clearBtn) {
          clearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            state.filters[filterKey] = [];
            updateFilterDisplay(wrap, filterKey, isMulti);
            closeAllDropdowns();
            renderAll();
          });
        }
      }
    });

    // Close dropdowns on outside click
    document.addEventListener('click', () => closeAllDropdowns());
  }

  function getFilterOptions(key) {
    const map = {
      customer: DashboardData.filters.customers,
      plant: DashboardData.filters.plants,
      dateType: DashboardData.filters.dateTypes,
      lotType: DashboardData.filters.lotTypes,
      unitType: DashboardData.filters.unitTypes,
      projectType: DashboardData.filters.projectTypes
    };
    return map[key] || [];
  }

  function renderFilterOptions(container, options, isMulti, filterKey) {
    container.innerHTML = '';
    options.forEach(opt => {
      const div = document.createElement('div');
      div.className = 'dc-select-option';
      div.dataset.value = opt.id;
      if (isMulti) {
        const checked = state.filters[filterKey] === 'ALL' || (Array.isArray(state.filters[filterKey]) && state.filters[filterKey].includes(opt.id));
        div.innerHTML = `<input type="checkbox" ${checked ? 'checked' : ''} tabindex="-1"><span>${opt.label}</span>`;
        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const cb = div.querySelector('input');
          cb.checked = !cb.checked;
          div.classList.toggle('dc-option-active', cb.checked);
          updateMultiFilter(filterKey, opt.id, cb.checked);
          updateFilterDisplay(div.closest('.dc-select-wrap'), filterKey, true);
          renderAll();
        });
      } else {
        div.textContent = opt.label;
        if (state.filters[filterKey] === opt.id) div.classList.add('dc-option-active');
        div.addEventListener('click', (e) => {
          e.stopPropagation();
          state.filters[filterKey] = opt.id;
          updateFilterDisplay(div.closest('.dc-select-wrap'), filterKey, false);
          closeAllDropdowns();
          renderAll();
        });
      }
      container.appendChild(div);
    });
  }

  function updateMultiFilter(key, value, add) {
    if (value === 'ALL') {
      state.filters[key] = add ? 'ALL' : [];
      return;
    }
    if (!Array.isArray(state.filters[key])) state.filters[key] = [];
    if (add) {
      state.filters[key].push(value);
    } else {
      state.filters[key] = state.filters[key].filter(v => v !== value);
    }
  }

  function updateFilterDisplay(wrap, filterKey, isMulti) {
    const textSpan = wrap.querySelector('.dc-select-text');
    const val = state.filters[filterKey];
    if (!isMulti) {
      const opt = getFilterOptions(filterKey).find(o => o.id === val);
      textSpan.textContent = opt ? opt.label : val;
    } else if (val === 'ALL') {
      textSpan.textContent = 'All Selected';
    } else if (Array.isArray(val) && val.length === 0) {
      textSpan.textContent = 'None';
    } else if (Array.isArray(val)) {
      textSpan.textContent = `${val.length} selected`;
    }
  }

  function filterVisibleOptions(wrap, query) {
    const options = wrap.querySelectorAll('.dc-select-option');
    const q = query.toLowerCase();
    options.forEach(opt => {
      const text = opt.textContent.toLowerCase();
      opt.style.display = text.includes(q) ? '' : 'none';
    });
  }

  function closeAllDropdowns() {
    document.querySelectorAll('.dc-select-wrap.open').forEach(w => w.classList.remove('open'));
  }

  // ========================================================
  // Chart Initialization
  // ========================================================
  function initCharts() {
    chartTrend = echarts.init(document.getElementById('chartTrend'));
    chartPareto = echarts.init(document.getElementById('chartPareto'));
    chartDefectTrend = echarts.init(document.getElementById('chartDefectTrend'));
    chartDeptDonut = echarts.init(document.getElementById('chartDepartmentDonut'));

    // Trend chart click handler
    chartTrend.on('click', function (params) {
      if (params.componentType === 'series') {
        state.selectedWeekIndex = params.dataIndex;
        renderAll();
      }
    });

    // Pareto chart click handler
    chartPareto.on('click', function (params) {
      if (params.componentType === 'series' && params.seriesType === 'bar') {
        const code = params.name;
        state.selectedDefectCode = code;
        renderDrilldown(code);
        // Highlight the clicked bar
        chartPareto.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: params.dataIndex });
      }
    });
  }

  // ========================================================
  // Render Everything
  // ========================================================
  function renderAll() {
    renderTrendChart();
    renderKPI();
    renderParetoChart();
    if (state.selectedDefectCode) {
      renderDrilldown(state.selectedDefectCode);
    } else {
      // Select latest defect code by default
      state.selectedDefectCode = DashboardData.defectCodes[0].code;
      renderDrilldown(state.selectedDefectCode);
    }
  }

  // ========================================================
  // Trend Chart (CH-01)
  // ========================================================
  function renderTrendChart() {
    const data = DashboardData.weeklySummary;
    const weeks = data.map(d => d.label);
    const yields = data.map(d => d.yield);
    const targets = data.map(() => data[0].target);
    const outputs = data.map(d => d.output);

    const selectedIndex = state.selectedWeekIndex;

    const option = {
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(255,255,255,0.96)',
        borderColor: '#d9e1e7',
        borderWidth: 1,
        textStyle: { fontFamily: 'Plus Jakarta Sans, Arial Nova, sans-serif', fontSize: 12, color: '#111315' },
        axisPointer: { type: 'cross', crossStyle: { color: '#999' } },
        formatter: function (params) {
          let html = `<div style="font-weight:600;margin-bottom:6px">${params[0].axisValue}</div>`;
          params.forEach(p => {
            const marker = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:6px"></span>`;
            html += `<div style="display:flex;justify-content:space-between;gap:16px">${marker}${p.seriesName}: <strong>${p.seriesName === 'Output' ? p.value + ' Lots' : p.value + '%'}</strong></div>`;
          });
          return html;
        }
      },
      legend: {
        data: ['Yield', 'Target', 'Output'],
        top: 4,
        right: 10,
        textStyle: { fontFamily: 'Plus Jakarta Sans, Arial Nova, sans-serif', fontSize: 11, color: '#647280' },
        itemWidth: 12,
        itemHeight: 8,
        itemGap: 16
      },
      grid: { left: 56, right: 56, top: 40, bottom: 32 },
      xAxis: {
        type: 'category',
        data: weeks,
        axisLine: { lineStyle: { color: '#d9e1e7' } },
        axisTick: { show: false },
        axisLabel: { fontSize: 11, color: '#647280', fontFamily: 'Plus Jakarta Sans, Arial Nova, sans-serif' }
      },
      yAxis: [
        {
          type: 'value',
          name: 'Yield %',
          min: 93,
          max: 98,
          nameTextStyle: { fontSize: 11, color: '#647280', padding: [0, 0, 0, -20] },
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { lineStyle: { color: '#eef2f4', type: 'dashed' } },
          axisLabel: { fontSize: 11, color: '#647280', formatter: '{value}%' }
        },
        {
          type: 'value',
          name: 'Output',
          min: 120,
          max: 180,
          nameTextStyle: { fontSize: 11, color: '#647280' },
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { show: false },
          axisLabel: { fontSize: 11, color: '#647280', formatter: '{value}' }
        }
      ],
      series: [
        {
          name: 'Output',
          type: 'bar',
          yAxisIndex: 1,
          data: outputs.map((v, i) => ({
            value: v,
            itemStyle: {
              color: selectedIndex === -1 || selectedIndex === i
                ? new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                    { offset: 0, color: 'rgba(37,99,235,0.35)' },
                    { offset: 1, color: 'rgba(37,99,235,0.08)' }
                  ])
                : 'rgba(37,99,235,0.08)',
              borderRadius: [3, 3, 0, 0]
            }
          })),
          barWidth: '45%'
        },
        {
          name: 'Yield',
          type: 'line',
          data: yields,
          smooth: true,
          symbol: 'circle',
          symbolSize: 7,
          lineStyle: { color: '#2563eb', width: 2.5 },
          itemStyle: {
            color: function (params) {
              return params.dataIndex === selectedIndex ? '#2563eb' : '#fff';
            },
            borderColor: '#2563eb',
            borderWidth: 2
          },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(37,99,235,0.12)' },
              { offset: 1, color: 'rgba(37,99,235,0.01)' }
            ])
          },
          label: {
            show: false
          },
          emphasis: {
            itemStyle: { borderWidth: 3, shadowBlur: 8, shadowColor: 'rgba(37,99,235,0.3)' }
          }
        },
        {
          name: 'Target',
          type: 'line',
          data: targets,
          lineStyle: { color: '#c2413b', width: 1.5, type: 'dashed' },
          symbol: 'none',
          itemStyle: { color: '#c2413b' }
        }
      ],
      animationDuration: 600,
      animationEasing: 'cubicOut'
    };

    chartTrend.setOption(option, true);

    // Update selected week label
    const labelEl = document.getElementById('selectedWeekLabel');
    if (selectedIndex >= 0 && selectedIndex < data.length) {
      labelEl.innerHTML = `Selected: <strong>${data[selectedIndex].label} (${data[selectedIndex].week})</strong>`;
    } else {
      labelEl.innerHTML = 'Selected: <strong>All Weeks</strong>';
    }
  }

  // ========================================================
  // KPI Cards
  // ========================================================
  function renderKPI() {
    const data = DashboardData.weeklySummary;
    const idx = state.selectedWeekIndex;
    const item = idx >= 0 && idx < data.length ? data[idx] : data[data.length - 1];
    const prevItem = idx > 0 ? data[idx - 1] : null;

    // Yield
    document.getElementById('kpiYield').textContent = item.yield.toFixed(2) + '%';
    document.getElementById('kpiYieldTarget').textContent = 'Target: ' + item.target.toFixed(2) + '%';

    const yieldTrend = document.getElementById('kpiYieldTrend');
    if (prevItem) {
      const diff = (item.yield - prevItem.yield).toFixed(2);
      yieldTrend.querySelector('span').textContent = (diff >= 0 ? '+' : '') + diff + '%';
      yieldTrend.className = 'dc-kpi-trend ' + (diff >= 0 ? 'dc-kpi-trend-up' : 'dc-kpi-trend-down');
    } else {
      yieldTrend.querySelector('span').textContent = '--';
      yieldTrend.className = 'dc-kpi-trend neutral';
    }

    // Output
    document.getElementById('kpiOutput').textContent = item.output + ' Lots';
    document.getElementById('kpiLots').textContent = 'Input: ' + item.input + ' Lots';

    // Loss
    const lossValue = (item.input - item.output);
    document.getElementById('kpiLoss').textContent = lossValue + ' Lots';
    const lossRatio = ((lossValue / item.input) * 100).toFixed(2);
    document.getElementById('kpiLossRatio').textContent = 'Loss Ratio: ' + lossRatio + '%';

    const lossTrend = document.getElementById('kpiLossTrend');
    if (prevItem) {
      const prevLoss = prevItem.input - prevItem.output;
      const diff = lossValue - prevLoss;
      lossTrend.querySelector('span').textContent = (diff <= 0 ? '' : '+') + diff + ' Lots';
      lossTrend.className = 'dc-kpi-trend ' + (diff <= 0 ? 'dc-kpi-trend-down' : 'dc-kpi-trend-up');
    } else {
      lossTrend.querySelector('span').textContent = '--';
      lossTrend.className = 'dc-kpi-trend neutral';
    }

    // Finished Count
    document.getElementById('kpiFinishedCount').textContent = item.output + ' Lots';
    document.getElementById('kpiInputQty').textContent = 'Input: ' + item.input + ' Lots';

    // Update selected week label
    const labelEl = document.getElementById('selectedWeekLabel');
    if (idx >= 0 && idx < data.length) {
      labelEl.innerHTML = 'Selected: <strong>' + item.label + ' (' + item.week + ')</strong>';
    } else {
      labelEl.innerHTML = 'Selected: <strong>All Weeks</strong>';
    }
  }

  // ========================================================
  // Pareto Chart (CH-02)
  // ========================================================
  function renderParetoChart() {
    const defects = DashboardData.defectCodes;
    const codes = defects.map(d => d.code);
    const totalLoss = defects.map(d => d.totalLoss);
    const coreLoss = defects.map(d => d.coreLoss);

    const option = {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        backgroundColor: 'rgba(255,255,255,0.96)',
        borderColor: '#d9e1e7',
        borderWidth: 1,
        textStyle: { fontFamily: 'Plus Jakarta Sans, Arial Nova, sans-serif', fontSize: 12, color: '#111315' },
        formatter: function (params) {
          let html = '<div style="font-weight:600;margin-bottom:4px">' + params[0].name + '</div>';
          params.forEach(p => {
            const marker = '<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + p.color + ';margin-right:6px"></span>';
            html += '<div>' + marker + p.seriesName + ': <strong>' + p.value + '%</strong></div>';
          });
          const def = defects.find(d => d.code === params[0].name);
          if (def) {
            html += '<div style="margin-top:4px;font-size:11px;color:#647280">' + def.name + ' | ' + def.dept + '</div>';
          }
          return html;
        }
      },
      legend: {
        data: ['Total Loss Ratio', 'Core Loss Ratio'],
        top: 4,
        right: 10,
        textStyle: { fontFamily: 'Plus Jakarta Sans, Arial Nova, sans-serif', fontSize: 11, color: '#647280' },
        itemWidth: 12,
        itemHeight: 8
      },
      grid: { left: 90, right: 30, top: 40, bottom: 20 },
      xAxis: {
        type: 'value',
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: '#eef2f4', type: 'dashed' } },
        axisLabel: { fontSize: 11, color: '#647280', formatter: '{value}%' }
      },
      yAxis: {
        type: 'category',
        data: codes.slice().reverse(),
        axisLine: { lineStyle: { color: '#d9e1e7' } },
        axisTick: { show: false },
        axisLabel: {
          fontSize: 11,
          color: '#111315',
          fontWeight: 600,
          fontFamily: 'Plus Jakarta Sans, Arial Nova, sans-serif'
        }
      },
      series: [
        {
          name: 'Total Loss Ratio',
          type: 'bar',
          data: totalLoss.slice().reverse(),
          barWidth: '45%',
          itemStyle: {
            color: function (params) {
              const code = codes.slice().reverse()[params.dataIndex];
              if (code === state.selectedDefectCode) {
                return new echarts.graphic.LinearGradient(0, 0, 1, 0, [
                  { offset: 0, color: '#c2413b' },
                  { offset: 1, color: '#e5695f' }
                ]);
              }
              return '#c2413b';
            },
            borderRadius: [0, 3, 3, 0]
          },
          emphasis: {
            itemStyle: { shadowBlur: 8, shadowColor: 'rgba(194,65,59,0.3)' }
          },
          label: {
            show: true,
            position: 'right',
            fontSize: 10,
            color: '#647280',
            formatter: '{c}%'
          }
        },
        {
          name: 'Core Loss Ratio',
          type: 'bar',
          data: coreLoss.slice().reverse(),
          barWidth: '45%',
          itemStyle: {
            color: function (params) {
              const code = codes.slice().reverse()[params.dataIndex];
              if (code === state.selectedDefectCode) {
                return new echarts.graphic.LinearGradient(0, 0, 1, 0, [
                  { offset: 0, color: '#2563eb' },
                  { offset: 1, color: '#60a5fa' }
                ]);
              }
              return '#2563eb';
            },
            borderRadius: [0, 3, 3, 0],
            opacity: 0.65
          },
          emphasis: {
            itemStyle: { shadowBlur: 8, shadowColor: 'rgba(37,99,235,0.3)' }
          }
        }
      ],
      animationDuration: 500,
      animationEasing: 'cubicOut'
    };

    chartPareto.setOption(option, true);
  }

  // ========================================================
  // Drilldown Panel
  // ========================================================
  function renderDrilldown(code) {
    const def = DashboardData.defectCodes.find(d => d.code === code);
    if (!def) return;

    // Update header
    document.getElementById('drilldownTitle').textContent = code + ' — ' + def.name;
    document.getElementById('drilldownSubtitle').textContent = 'Department: ' + def.dept + ' | Total Loss: ' + def.totalLoss + '%';

    renderDefectTrend(code);
    renderDeptDonut(code);
  }

  // Defect Trend Line
  function renderDefectTrend(code) {
    const trendData = DashboardData.getDefectTrend(code);
    const weeks = trendData.map(d => d.week);
    const qty = trendData.map(d => d.qty);

    const option = {
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(255,255,255,0.96)',
        borderColor: '#d9e1e7',
        borderWidth: 1,
        textStyle: { fontFamily: 'Plus Jakarta Sans, Arial Nova, sans-serif', fontSize: 11, color: '#111315' },
        formatter: function (params) {
          return '<div style="font-weight:600">' + params[0].axisValue + '</div><div>Defect Qty: <strong>' + params[0].value + '</strong></div>';
        }
      },
      grid: { left: 40, right: 16, top: 12, bottom: 24 },
      xAxis: {
        type: 'category',
        data: weeks,
        axisLine: { lineStyle: { color: '#d9e1e7' } },
        axisTick: { show: false },
        axisLabel: { fontSize: 10, color: '#647280' }
      },
      yAxis: {
        type: 'value',
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: '#eef2f4', type: 'dashed' } },
        axisLabel: { fontSize: 10, color: '#647280' }
      },
      series: [
        {
          type: 'line',
          data: qty,
          smooth: true,
          symbol: 'circle',
          symbolSize: 5,
          lineStyle: { color: '#c2413b', width: 2 },
          itemStyle: { color: '#fff', borderColor: '#c2413b', borderWidth: 2 },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(194,65,59,0.15)' },
              { offset: 1, color: 'rgba(194,65,59,0.01)' }
            ])
          }
        }
      ],
      animationDuration: 400
    };

    chartDefectTrend.setOption(option, true);
  }

  // Department Donut
  function renderDeptDonut(code) {
    const deptData = DashboardData.getDeptBreakdown(code);
    const total = deptData.reduce((s, d) => s + d.value, 0);

    const option = {
      tooltip: {
        trigger: 'item',
        backgroundColor: 'rgba(255,255,255,0.96)',
        borderColor: '#d9e1e7',
        borderWidth: 1,
        textStyle: { fontFamily: 'Plus Jakarta Sans, Arial Nova, sans-serif', fontSize: 11, color: '#111315' },
        formatter: function (params) {
          return '<div style="font-weight:600">' + params.name + '</div><div>' + params.value + ' (' + params.percent + '%)</div>';
        }
      },
      series: [
        {
          type: 'pie',
          radius: ['42%', '70%'],
          center: ['50%', '50%'],
          avoidLabelOverlap: true,
          itemStyle: { borderRadius: 4, borderColor: '#fff', borderWidth: 2 },
          label: {
            show: true,
            fontSize: 10,
            color: '#424a55',
            fontFamily: 'Plus Jakarta Sans, Arial Nova, sans-serif',
            formatter: function (params) {
              if (params.percent < 8) return '';
              return params.name + '\n' + params.percent + '%';
            }
          },
          labelLine: { show: true, length: 6, length2: 8, lineStyle: { color: '#d9e1e7' } },
          emphasis: {
            itemStyle: { shadowBlur: 10, shadowColor: 'rgba(37,99,235,0.2)' },
            label: { fontSize: 12, fontWeight: 600 }
          },
          data: deptData.map(d => ({
            value: d.value,
            name: d.name,
            itemStyle: { color: d.color }
          }))
        }
      ],
      animationDuration: 400
    };

    chartDeptDonut.setOption(option, true);
  }

  // ========================================================
  // Export to CSV
  // ========================================================
  function initExport() {
    document.getElementById('btnExport').addEventListener('click', () => {
      exportToCSV();
    });
  }

  function exportToCSV() {
    const data = DashboardData.weeklySummary;
    const filterContext = Object.entries(state.filters)
      .map(([k, v]) => k + '=' + (Array.isArray(v) ? v.join(';') : v))
      .join(' | ');

    let csv = 'QDM Finished Lot Yield Dashboard Export\n';
    csv += 'Filters: ' + filterContext + '\n';
    csv += 'Generated: ' + new Date().toISOString() + '\n\n';
    csv += 'Week,Date Type,Lot Type,Unit Type,Yield (%),Target (%),Output (NSQM),Input,Loss (NSQM)\n';

    data.forEach(row => {
      csv += [
        row.week,
        state.filters.dateType,
        state.filters.lotType,
        state.filters.unitType,
        row.yield.toFixed(2),
        row.target.toFixed(2),
        row.output,
        row.input,
        (row.input - row.output)
      ].join(',') + '\n';
    });

    // Add defect data
    csv += '\nDefect Code,Name,Department,Total Loss %,Core Loss %\n';
    DashboardData.defectCodes.forEach(d => {
      csv += [d.code, '"' + d.name + '"', d.dept, d.totalLoss.toFixed(2), d.coreLoss.toFixed(2)].join(',') + '\n';
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const filterSuffix = state.filters.dateType + '_' + state.filters.lotType + '_' + state.filters.unitType;
    a.download = 'QDM_Yield_Dashboard_' + filterSuffix + '_' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ========================================================
  // Reset Button
  // ========================================================
  function initResetButton() {
    document.getElementById('btnResetFilters').addEventListener('click', () => {
      state.filters = {
        customer: 'ALL',
        plant: 'ALL',
        dateType: 'Weekly',
        lotType: 'HVM',
        unitType: 'NSQM',
        projectType: 'Overall'
      };
      state.selectedWeekIndex = -1;
      state.selectedDefectCode = null;
      // Reset filter displays
      document.querySelectorAll('.dc-select-wrap').forEach(wrap => {
        const filterKey = wrap.dataset.filter;
        const isMulti = !wrap.querySelector('.dc-single');
        updateFilterDisplay(wrap, filterKey, isMulti);
      });
      document.getElementById('overlayEmpty').classList.add('dc-hidden');
      renderAll();
    });
  }

  // ========================================================
  // Responsive
  // ========================================================
  function handleResize() {
    if (chartTrend) chartTrend.resize();
    if (chartPareto) chartPareto.resize();
    if (chartDefectTrend) chartDefectTrend.resize();
    if (chartDeptDonut) chartDeptDonut.resize();
  }

  // ========================================================
  // Utility
  // ========================================================
  function debounce(fn, ms) {
    let timer;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  }

})();
