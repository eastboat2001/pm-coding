/* ============================================================
   Chart Rendering Module — Chart.js wrappers
   ============================================================ */

const ChartManager = (() => {

  // Shared defaults matching AITC tokens
  const COLORS = {
    primaryBlue: '#2563eb',
    primaryBlueLight: '#60a5fa',
    primaryBlueBg: 'rgba(37,99,235,0.08)',
    danger: '#c2413b',
    dangerLight: '#e5736d',
    dangerBg: 'rgba(194,65,59,0.10)',
    border: '#d9e1e7',
    textPrimary: '#111315',
    textSecondary: '#424a55',
    textMuted: '#647280',
    panelBg: '#ffffff',
    pageBg: '#f6f8fb',
    softBluePanel: '#f0f6ff',
    greenSuccess: '#0d9488',
    orangeWarn: '#d97706',
    purpleAccent: '#7c3aed',
    tealAccent: '#0891b2',
    amberAccent: '#d97706',
    roseAccent: '#e11d48',
  };

  const PALETTE = [
    COLORS.primaryBlue,
    COLORS.danger,
    '#0d9488',
    '#d97706',
    '#7c3aed',
    '#0891b2',
    '#e11d48',
    '#ea580c',
    '#4f46e5',
    '#059669',
    '#c026d3',
    '#ca8a04',
    '#2563eb',
    '#dc2626',
    '#0284c7',
  ];

  const chartInstances = {};

  function destroyChart(id) {
    if (chartInstances[id]) {
      chartInstances[id].destroy();
      delete chartInstances[id];
    }
  }

  function getCanvas(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    return el.getContext('2d');
  }

  // Shared tooltip style
  const tooltipStyle = {
    backgroundColor: 'rgba(17,19,21,0.92)',
    titleFont: { family: 'Arial Nova, Plus Jakarta Sans, sans-serif', size: 12, weight: '600' },
    bodyFont: { family: 'Arial Nova, Plus Jakarta Sans, sans-serif', size: 12, weight: '400' },
    padding: 10,
    cornerRadius: 6,
    displayColors: true,
    boxPadding: 4,
  };

  // Shared scale defaults
  const scaleDefaults = {
    ticks: {
      font: { family: 'Arial Nova, Plus Jakarta Sans, sans-serif', size: 11 },
      color: COLORS.textMuted,
    },
    grid: { color: 'rgba(217,225,231,0.5)' },
    border: { display: false },
  };

  /**
   * CH-01: Finished Overall Trend — Bar + Line combo chart
   */
  function renderYieldTrend(canvasId, trendData, onBarClick) {
    destroyChart(canvasId);
    const ctx = getCanvas(canvasId);
    if (!ctx || !trendData || trendData.length === 0) return;

    const labels = trendData.map(d => d.WeekLabel);
    const yields = trendData.map(d => d.Yield);
    const targets = trendData.map(d => d.Target);
    const outputs = trendData.map(d => d.Output_NSQM);

    chartInstances[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Output (NSQM)',
            data: outputs,
            backgroundColor: COLORS.primaryBlueBg,
            borderColor: COLORS.primaryBlue,
            borderWidth: 1.5,
            borderRadius: 4,
            yAxisID: 'y1',
            order: 2,
          },
          {
            label: 'Yield (%)',
            data: yields,
            type: 'line',
            borderColor: COLORS.primaryBlue,
            backgroundColor: COLORS.primaryBlue,
            pointBackgroundColor: COLORS.primaryBlue,
            pointBorderColor: '#fff',
            pointBorderWidth: 2,
            pointRadius: 5,
            pointHoverRadius: 7,
            borderWidth: 2.5,
            tension: 0.3,
            fill: false,
            yAxisID: 'y',
            order: 0,
          },
          {
            label: 'Target (%)',
            data: targets,
            type: 'line',
            borderColor: COLORS.danger,
            backgroundColor: 'transparent',
            pointBackgroundColor: COLORS.danger,
            pointBorderColor: '#fff',
            pointBorderWidth: 2,
            pointRadius: 4,
            pointHoverRadius: 6,
            borderWidth: 2,
            borderDash: [6, 4],
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
        onClick: (evt, elements) => {
          if (elements.length > 0 && onBarClick) {
            const idx = elements[0].index;
            onBarClick(trendData[idx]);
          }
        },
        plugins: {
          legend: {
            position: 'top',
            align: 'end',
            labels: {
              font: { family: 'Arial Nova, Plus Jakarta Sans, sans-serif', size: 11, weight: '500' },
              color: COLORS.textSecondary,
              usePointStyle: true,
              pointStyle: 'rectRounded',
              padding: 16,
            },
          },
          tooltip: {
            ...tooltipStyle,
            callbacks: {
              title: (items) => {
                const idx = items[0].dataIndex;
                return trendData[idx] ? `${trendData[idx].WeekLabel} (${trendData[idx].WeekDate})` : items[0].label;
              },
              label: (item) => {
                if (item.dataset.label.includes('Output')) {
                  return `Output: ${item.raw.toLocaleString()} NSQM`;
                }
                return `${item.dataset.label}: ${item.raw.toFixed(2)}%`;
              },
            },
          },
        },
        scales: {
          x: {
            ...scaleDefaults,
            ticks: { ...scaleDefaults.ticks, maxRotation: 0 },
          },
          y: {
            ...scaleDefaults,
            position: 'left',
            title: { display: true, text: 'Yield (%)', font: { family: 'Arial Nova, Plus Jakarta Sans, sans-serif', size: 11, weight: '500' }, color: COLORS.textMuted },
            min: 93,
            max: 99,
          },
          y1: {
            ...scaleDefaults,
            position: 'right',
            title: { display: true, text: 'Output (NSQM)', font: { family: 'Arial Nova, Plus Jakarta Sans, sans-serif', size: 11, weight: '500' }, color: COLORS.textMuted },
            grid: { drawOnChartArea: false },
          },
        },
      },
    });

    return chartInstances[canvasId];
  }

  /**
   * CH-02: Defect Loss Ratio — Horizontal Bar (Pareto)
   */
  function renderDefectPareto(canvasId, paretoData, onBarClick) {
    destroyChart(canvasId);
    const ctx = getCanvas(canvasId);
    if (!ctx || !paretoData || paretoData.length === 0) return;

    // Reverse for horizontal (top defect at top)
    const reversed = [...paretoData].reverse();
    const labels = reversed.map(d => `${d.DefectCode} (${d.DefectName})`);
    const totalLoss = reversed.map(d => d.AvgLossRatio);
    const coreLoss = reversed.map(d => d.CoreLossRatio > 0 ? d.AvgLossRatio : 0);

    chartInstances[canvasId] = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Total Loss Ratio',
            data: totalLoss,
            backgroundColor: COLORS.dangerBg,
            borderColor: COLORS.danger,
            borderWidth: 1.5,
            borderRadius: 3,
          },
          {
            label: 'Core Loss Ratio',
            data: coreLoss,
            backgroundColor: COLORS.primaryBlueBg,
            borderColor: COLORS.primaryBlue,
            borderWidth: 1.5,
            borderRadius: 3,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        onClick: (evt, elements) => {
          if (elements.length > 0 && onBarClick) {
            const idx = elements[0].index;
            const realIdx = reversed.length - 1 - idx;
            onBarClick(paretoData[realIdx]);
          }
        },
        plugins: {
          legend: {
            position: 'top',
            align: 'end',
            labels: {
              font: { family: 'Arial Nova, Plus Jakarta Sans, sans-serif', size: 11, weight: '500' },
              color: COLORS.textSecondary,
              usePointStyle: true,
              pointStyle: 'rectRounded',
              padding: 16,
            },
          },
          tooltip: {
            ...tooltipStyle,
            callbacks: {
              title: (items) => {
                const idx = items[0].dataIndex;
                return reversed[idx] ? `${reversed[idx].DefectCode} — ${reversed[idx].DefectName}` : items[0].label;
              },
              label: (item) => `${item.dataset.label}: ${item.raw.toFixed(2)}%`,
            },
          },
        },
        scales: {
          x: {
            ...scaleDefaults,
            title: { display: true, text: 'Loss Ratio (%)', font: { family: 'Arial Nova, Plus Jakarta Sans, sans-serif', size: 11, weight: '500' }, color: COLORS.textMuted },
          },
          y: {
            ...scaleDefaults,
            ticks: {
              ...scaleDefaults.ticks,
              font: { family: 'Arial Nova, Plus Jakarta Sans, sans-serif', size: 10 },
              autoSkip: false,
            },
          },
        },
      },
    });

    return chartInstances[canvasId];
  }

  /**
   * CH-03a: Defect Trend — Line chart
   */
  function renderDefectTrend(canvasId, trendData) {
    destroyChart(canvasId);
    const ctx = getCanvas(canvasId);
    if (!ctx || !trendData || trendData.length === 0) return;

    const labels = trendData.map(d => d.WeekLabel);
    const values = trendData.map(d => d.LossRatio);

    chartInstances[canvasId] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Loss Ratio (%)',
          data: values,
          borderColor: COLORS.danger,
          backgroundColor: COLORS.dangerBg,
          pointBackgroundColor: COLORS.danger,
          pointBorderColor: '#fff',
          pointBorderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6,
          borderWidth: 2.5,
          tension: 0.35,
          fill: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            ...tooltipStyle,
            callbacks: {
              title: (items) => {
                const idx = items[0].dataIndex;
                return trendData[idx] ? trendData[idx].WeekLabel : items[0].label;
              },
              label: (item) => `Loss Ratio: ${item.raw.toFixed(2)}%`,
            },
          },
        },
        scales: {
          x: { ...scaleDefaults, ticks: { ...scaleDefaults.ticks, maxRotation: 0 } },
          y: {
            ...scaleDefaults,
            title: { display: true, text: 'Loss Ratio (%)', font: { family: 'Arial Nova, Plus Jakarta Sans, sans-serif', size: 11, weight: '500' }, color: COLORS.textMuted },
            beginAtZero: true,
          },
        },
      },
    });

    return chartInstances[canvasId];
  }

  /**
   * CH-03b: Department Attribution — Donut
   */
  function renderDeptDonut(canvasId, deptData) {
    destroyChart(canvasId);
    const ctx = getCanvas(canvasId);
    if (!ctx || !deptData || deptData.length === 0) return;

    const labels = deptData.map(d => d.Department);
    const values = deptData.map(d => d.Qty);
    const total = values.reduce((s, v) => s + v, 0);
    const colors = deptData.map((_, i) => PALETTE[i % PALETTE.length]);

    chartInstances[canvasId] = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: colors.map(c => c + '33'),
          borderColor: colors,
          borderWidth: 2,
          hoverOffset: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '58%',
        plugins: {
          legend: {
            position: 'right',
            labels: {
              font: { family: 'Arial Nova, Plus Jakarta Sans, sans-serif', size: 11, weight: '500' },
              color: COLORS.textSecondary,
              usePointStyle: true,
              pointStyle: 'circle',
              padding: 12,
              generateLabels: (chart) => {
                const data = chart.data;
                if (!data.labels || !data.datasets[0]) return [];
                return data.labels.map((label, i) => {
                  const val = data.datasets[0].data[i];
                  const pct = total > 0 ? ((val / total) * 100).toFixed(1) : 0;
                  return {
                    text: `${label} (${pct}%)`,
                    fillStyle: data.datasets[0].backgroundColor[i],
                    strokeStyle: data.datasets[0].borderColor[i],
                    lineWidth: 2,
                    hidden: false,
                    index: i,
                    pointStyle: 'circle',
                  };
                });
              },
            },
          },
          tooltip: {
            ...tooltipStyle,
            callbacks: {
              label: (item) => {
                const pct = total > 0 ? ((item.raw / total) * 100).toFixed(1) : 0;
                return ` ${item.label}: ${item.raw.toLocaleString()} (${pct}%)`;
              },
            },
          },
        },
      },
    });

    return chartInstances[canvasId];
  }

  // Public API
  return {
    COLORS,
    renderYieldTrend,
    renderDefectPareto,
    renderDefectTrend,
    renderDeptDonut,
    destroyChart,
  };

})();
