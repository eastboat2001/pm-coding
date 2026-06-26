/* ============================================================
   QDM Finished Lot Yield Dashboard — Full Application Logic
   AITC Enterprise Style · Chart.js · Vanilla JS
   ============================================================ */

(function () {
    'use strict';

    /* --------------------------------------------------------
       1. MOCK DATA GENERATION
       -------------------------------------------------------- */
    const WEEKS = [
        { id: 202612, label: 'Mar 16 – Mar 22', short: 'W12', date: '2026-03-18' },
        { id: 202613, label: 'Mar 23 – Mar 29', short: 'W13', date: '2026-03-25' },
        { id: 202614, label: 'Mar 30 – Apr 05', short: 'W14', date: '2026-04-01' },
        { id: 202615, label: 'Apr 06 – Apr 12', short: 'W15', date: '2026-04-08' },
        { id: 202616, label: 'Apr 13 – Apr 19', short: 'W16', date: '2026-04-15' },
        { id: 202617, label: 'Apr 20 – Apr 26', short: 'W17', date: '2026-04-22' },
        { id: 202618, label: 'Apr 27 – May 03', short: 'W18', date: '2026-04-29' },
        { id: 202619, label: 'May 04 – May 10', short: 'W19', date: '2026-05-06' },
        { id: 202620, label: 'May 11 – May 17', short: 'W20', date: '2026-05-13' },
        { id: 202621, label: 'May 18 – May 24', short: 'W21', date: '2026-05-20' },
    ];

    const CUSTOMERS = ['Alpha Corp', 'Beta Semi', 'Gamma Tech', 'Delta Micro', 'Epsilon IC'];
    const PLANTS = ['Plant A', 'Plant B', 'Plant C'];
    const TARGET = 94.81;

    const DEFECT_CODES = [
        { code: 'ED25', name: 'Short in Inner Layer', dept: 'Etching + AOI' },
        { code: 'AP09', name: 'Component Tilting', dept: 'Assembly' },
        { code: 'GE01', name: 'Scratches', dept: 'Material' },
        { code: 'BK12', name: 'Solder Bridge', dept: 'Soldering' },
        { code: 'CF03', name: 'Open Circuit', dept: 'Etching + AOI' },
        { code: 'DR07', name: 'Insufficient Solder', dept: 'Soldering' },
        { code: 'FT15', name: 'Missing Component', dept: 'Assembly' },
        { code: 'HL08', name: 'Delamination', dept: 'Material' },
        { code: 'IS21', name: 'Misalignment', dept: 'Alignment' },
        { code: 'JD04', name: 'Crack', dept: 'Material' },
        { code: 'KN11', name: 'Void', dept: 'Soldering' },
        { code: 'LM06', name: 'Tombstoning', dept: 'Assembly' },
        { code: 'NP19', name: 'Polarity Error', dept: 'Assembly' },
        { code: 'QR02', name: 'Burr', dept: 'Etching + AOI' },
        { code: 'SV14', name: 'Oxidation', dept: 'Material' },
    ];

    const DEPARTMENTS = ['Etching + AOI', 'Assembly', 'Material', 'Soldering', 'Alignment'];

    function seededRandom(seed) {
        let s = seed;
        return function () {
            s = (s * 16807 + 0) % 2147483647;
            return s / 2147483647;
        };
    }

    function generateSummaryData() {
        const rng = seededRandom(42);
        const data = [];
        let yieldBase = 93.5;
        CUSTOMERS.forEach(customer => {
            PLANTS.forEach(plant => {
                ['HVM', 'LVM', 'NPI'].forEach(lotType => {
                    ['NSQM', 'NSOM'].forEach(unitType => {
                        ['Overall', 'Automotive', 'Consumer', 'Industrial'].forEach(projectType => {
                            WEEKS.forEach((week, wi) => {
                                yieldBase += (rng() - 0.47) * 0.5;
                                yieldBase = Math.max(90, Math.min(99, yieldBase));
                                const yieldVal = parseFloat(yieldBase.toFixed(2));
                                const inputQty = Math.floor(2800 + rng() * 900);
                                const outputNSQM = Math.floor(inputQty * yieldVal / 100);
                                const nsqmLoss = inputQty - outputNSQM;
                                data.push({
                                    atsDate: week.date,
                                    weekId: week.id,
                                    weekLabel: week.label,
                                    weekShort: week.short,
                                    dateType: 'Weekly',
                                    customer,
                                    plant,
                                    lotType,
                                    unitType,
                                    projectType,
                                    yield: yieldVal,
                                    outputNSQM,
                                    inputQty,
                                    nsqmLoss,
                                    target: TARGET,
                                });
                            });
                        });
                    });
                });
            });
        });
        return data;
    }

    function generateDefectData() {
        const rng = seededRandom(99);
        const data = [];
        CUSTOMERS.forEach(customer => {
            PLANTS.forEach(plant => {
                WEEKS.forEach(week => {
                    DEFECT_CODES.forEach(dc => {
                        const qty = Math.floor(20 + rng() * 180);
                        const lossRatio = parseFloat((rng() * 3.5 + 0.1).toFixed(3));
                        data.push({
                            atsDate: week.date,
                            weekId: week.id,
                            weekShort: week.short,
                            defectCode: dc.code,
                            defectName: dc.name,
                            defectQty: qty,
                            lossRatio,
                            department: dc.dept,
                            customer,
                            plant,
                        });
                    });
                });
            });
        });
        return data;
    }

    const allSummaryData = generateSummaryData();
    const allDefectData = generateDefectData();

    /* --------------------------------------------------------
       2. FILTER STATE & LOGIC
       -------------------------------------------------------- */
    const filterState = {
        customer: [...CUSTOMERS],
        plant: [...PLANTS],
        dateType: 'Weekly',
        lotType: 'HVM',
        unitType: 'NSQM',
        projectType: 'Overall',
    };

    function filterSummary() {
        return allSummaryData.filter(d =>
            filterState.customer.includes(d.customer) &&
            filterState.plant.includes(d.plant) &&
            d.lotType === filterState.lotType &&
            d.unitType === filterState.unitType &&
            d.projectType === filterState.projectType
        );
    }

    function filterDefects() {
        return allDefectData.filter(d =>
            filterState.customer.includes(d.customer) &&
            filterState.plant.includes(d.plant)
        );
    }

    function aggregateWeekly(summary) {
        const map = {};
        summary.forEach(d => {
            if (!map[d.weekId]) {
                map[d.weekId] = { ...d, _count: 1, _outputSum: d.outputNSQM, _inputSum: d.inputQty };
            } else {
                map[d.weekId]._count++;
                map[d.weekId]._outputSum += d.outputNSQM;
                map[d.weekId]._inputSum += d.inputQty;
            }
        });
        return WEEKS.map(w => {
            const m = map[w.id];
            if (!m) return null;
            const avgYield = m._inputSum > 0 ? parseFloat((m._outputSum / m._inputSum * 100).toFixed(2)) : 0;
            return {
                ...m,
                yield: avgYield,
                outputNSQM: m._outputSum,
                inputQty: m._inputSum,
                nsqmLoss: m._inputSum - m._outputSum,
            };
        }).filter(Boolean);
    }

    function aggregateDefectPareto(defectData) {
        const codeMap = {};
        defectData.forEach(d => {
            if (!codeMap[d.defectCode]) {
                codeMap[d.defectCode] = { ...d, totalQty: 0, totalLoss: 0 };
            }
            codeMap[d.defectCode].totalQty += d.defectQty;
            codeMap[d.defectCode].totalLoss += d.lossRatio;
        });
        return Object.values(codeMap)
            .sort((a, b) => b.totalQty - a.totalQty)
            .slice(0, 15);
    }

    /* --------------------------------------------------------
       3. CHART INSTANCES
       -------------------------------------------------------- */
    let trendChart = null;
    let paretoChart = null;
    let drillTrendChart = null;
    let drillDonutChart = null;

    const COLORS = {
        blue: '#2563eb',
        blueLight: 'rgba(37,99,235,0.12)',
        red: '#c2413b',
        redLight: 'rgba(194,65,59,0.12)',
        gray: '#94a3b8',
        grayLight: 'rgba(148,163,184,0.15)',
        green: '#16a34a',
        yellow: '#eab308',
        orange: '#ea580c',
    };

    const CHART_FONT = {
        family: '"Plus Jakarta Sans", "Arial Nova", system-ui, sans-serif',
        size: 11,
        weight: '500',
    };

    /* --------------------------------------------------------
       4. RENDER FUNCTIONS
       -------------------------------------------------------- */

    // --- KPI Panel ---
    let selectedWeekId = null;

    function updateKPI(weekData) {
        if (!weekData) return;
        selectedWeekId = weekData.weekId;
        document.getElementById('kpiWeekLabel').textContent = weekData.weekShort;
        document.getElementById('kpiWeekId').textContent = 'Week ' + weekData.weekId;
        document.getElementById('kpiYieldMain').textContent = weekData.yield.toFixed(2) + '%';
        document.getElementById('kpiYieldTarget').textContent = TARGET.toFixed(2) + '%';
        const barPct = Math.min(100, Math.max(0, weekData.yield));
        const bar = document.getElementById('kpiYieldBar');
        bar.style.width = barPct + '%';
        bar.className = 'kpi-bar-fill' + (weekData.yield < TARGET ? ' danger' : '');
        const statusEl = document.getElementById('kpiYieldStatus');
        if (weekData.yield >= TARGET) {
            statusEl.textContent = '▲ Above Target (' + (weekData.yield - TARGET).toFixed(2) + '%)';
            statusEl.className = 'kpi-card-status above-target';
        } else {
            statusEl.textContent = '▼ Below Target (' + (TARGET - weekData.yield).toFixed(2) + '%)';
            statusEl.className = 'kpi-card-status below-target';
        }
        document.getElementById('kpiOutputMain').textContent = weekData.outputNSQM.toLocaleString();
        document.getElementById('kpiCountMain').textContent = weekData.inputQty.toLocaleString();
        document.getElementById('kpiLossMain').textContent = weekData.nsqmLoss.toLocaleString();
        document.getElementById('kpiLossSub').textContent =
            ((weekData.nsqmLoss / weekData.inputQty) * 100).toFixed(2) + '% of input';
    }

    function fillTrendTable(weeklyData) {
        const tbody = document.getElementById('trendTableBody');
        tbody.innerHTML = weeklyData.map(d => `
            <tr>
                <td><strong>${d.weekId}</strong></td>
                <td>${d.weekLabel}</td>
                <td style="color:${d.yield >= TARGET ? COLORS.green : COLORS.red};font-weight:600">${d.yield.toFixed(2)}%</td>
                <td>${d.outputNSQM.toLocaleString()}</td>
                <td>${d.inputQty.toLocaleString()}</td>
                <td style="color:${COLORS.red}">${d.nsqmLoss.toLocaleString()}</td>
            </tr>
        `).join('');
    }

    // --- Trend Chart ---
    function renderTrendChart(weeklyData) {
        const labels = weeklyData.map(d => d.weekShort);
        const yieldData = weeklyData.map(d => d.yield);
        const outputData = weeklyData.map(d => d.outputNSQM);
        const targetLine = weeklyData.map(() => TARGET);

        const cfg = {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Output (NSQM)',
                        data: outputData,
                        backgroundColor: 'rgba(37,99,235,0.6)',
                        borderColor: 'rgba(37,99,235,0.9)',
                        borderWidth: 1,
                        borderRadius: 4,
                        yAxisID: 'yOutput',
                        order: 2,
                        barPercentage: 0.6,
                    },
                    {
                        label: 'Yield %',
                        data: yieldData,
                        type: 'line',
                        borderColor: COLORS.green,
                        backgroundColor: 'rgba(22,163,74,0.1)',
                        borderWidth: 2.5,
                        pointRadius: 4,
                        pointBackgroundColor: '#fff',
                        pointBorderColor: COLORS.green,
                        pointBorderWidth: 2,
                        pointHoverRadius: 6,
                        tension: 0.3,
                        fill: false,
                        yAxisID: 'yYield',
                        order: 1,
                    },
                    {
                        label: 'Target (' + TARGET + '%)',
                        data: targetLine,
                        type: 'line',
                        borderColor: COLORS.gray,
                        borderWidth: 1.5,
                        borderDash: [6, 4],
                        pointRadius: 0,
                        fill: false,
                        yAxisID: 'yYield',
                        order: 0,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                onClick: function (evt) {
                    const points = trendChart.getElementsAtEventForMode(evt, 'index', { intersect: false }, false);
                    if (points.length > 0) {
                        const idx = points[0].index;
                        updateKPI(weeklyData[idx]);
                        highlightWeek(idx);
                    }
                },
                plugins: {
                    legend: {
                        position: 'top',
                        labels: { font: CHART_FONT, usePointStyle: true, pointStyle: 'circle', padding: 16 },
                    },
                    tooltip: {
                        backgroundColor: 'rgba(17,19,21,0.92)',
                        titleFont: { ...CHART_FONT, weight: '700' },
                        bodyFont: CHART_FONT,
                        padding: 10,
                        cornerRadius: 6,
                        callbacks: {
                            afterBody: function (items) {
                                const idx = items[0].dataIndex;
                                const d = weeklyData[idx];
                                return [
                                    'Input: ' + d.inputQty.toLocaleString(),
                                    'Loss: ' + d.nsqmLoss.toLocaleString(),
                                    'Target: ' + TARGET + '%',
                                ];
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { font: CHART_FONT },
                    },
                    yOutput: {
                        position: 'left',
                        title: { display: true, text: 'Output (NSQM)', font: CHART_FONT },
                        ticks: { font: CHART_FONT },
                        grid: { color: 'rgba(0,0,0,0.04)' },
                    },
                    yYield: {
                        position: 'right',
                        title: { display: true, text: 'Yield %', font: CHART_FONT },
                        min: 88,
                        max: 100,
                        ticks: { font: CHART_FONT, callback: v => v + '%' },
                        grid: { drawOnChartArea: false },
                    },
                },
            },
        };

        if (trendChart) trendChart.destroy();
        trendChart = new Chart(document.getElementById('trendChart'), cfg);
    }

    function highlightWeek(idx) {
        if (!trendChart) return;
        const meta = trendChart.getDatasetMeta(0);
        meta.data.forEach((bar, i) => {
            bar.options.backgroundColor = i === idx
                ? 'rgba(37,99,235,0.9)'
                : 'rgba(37,99,235,0.35)';
        });
        trendChart.update('none');
    }

    // --- Pareto Chart ---
    let selectedDefectIdx = null;

    function renderParetoChart(paretoData) {
        const labels = paretoData.map(d => d.defectCode);
        const totalQtyData = paretoData.map(d => d.totalQty);
        const lossRatioData = paretoData.map(d => parseFloat(d.totalLoss.toFixed(2)));

        const cfg = {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Total Defect Qty',
                        data: totalQtyData,
                        backgroundColor: COLORS.red,
                        borderRadius: 3,
                        barPercentage: 0.65,
                        categoryPercentage: 0.8,
                    },
                    {
                        label: 'Loss Ratio (%)',
                        data: lossRatioData,
                        type: 'line',
                        borderColor: COLORS.blue,
                        borderWidth: 2,
                        pointRadius: 3,
                        pointBackgroundColor: COLORS.blue,
                        tension: 0.3,
                        fill: false,
                        yAxisID: 'yRatio',
                    },
                ],
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                onClick: function (evt) {
                    const points = paretoChart.getElementsAtEventForMode(evt, 'nearest', { intersect: true }, false);
                    if (points.length > 0) {
                        const idx = points[0].index;
                        selectedDefectIdx = idx;
                        highlightPareto(idx);
                        showDrillDown(paretoData[idx]);
                    }
                },
                plugins: {
                    legend: {
                        position: 'top',
                        labels: { font: CHART_FONT, usePointStyle: true, pointStyle: 'circle', padding: 16 },
                    },
                    tooltip: {
                        backgroundColor: 'rgba(17,19,21,0.92)',
                        titleFont: { ...CHART_FONT, weight: '700' },
                        bodyFont: CHART_FONT,
                        padding: 10,
                        cornerRadius: 6,
                        callbacks: {
                            afterBody: function (items) {
                                const idx = items[0].index;
                                const d = paretoData[idx];
                                return ['Name: ' + d.defectName, 'Dept: ' + d.department];
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        title: { display: true, text: 'Defect Qty', font: CHART_FONT },
                        ticks: { font: CHART_FONT },
                        grid: { color: 'rgba(0,0,0,0.04)' },
                    },
                    y: {
                        ticks: { font: { ...CHART_FONT, weight: '700' } },
                        grid: { display: false },
                    },
                    yRatio: {
                        position: 'top',
                        title: { display: true, text: 'Loss Ratio (%)', font: CHART_FONT },
                        ticks: { font: CHART_FONT, callback: v => v + '%' },
                        grid: { drawOnChartArea: false },
                    },
                },
            },
        };

        if (paretoChart) paretoChart.destroy();
        paretoChart = new Chart(document.getElementById('paretoChart'), cfg);
    }

    function highlightPareto(idx) {
        if (!paretoChart) return;
        const meta = paretoChart.getDatasetMeta(0);
        meta.data.forEach((bar, i) => {
            bar.options.backgroundColor = i === idx ? COLORS.red : COLORS.redLight;
        });
        paretoChart.update('none');
    }

    // --- Drill-down ---
    function showDrillDown(paretoItem) {
        document.getElementById('drillEmpty').classList.add('hidden');
        document.getElementById('drillCharts').classList.remove('hidden');
        document.getElementById('drillTitle').textContent = paretoItem.defectCode + ' — ' + paretoItem.defectName;
        document.getElementById('drillDept').textContent = paretoItem.department;

        renderDrillTrend(paretoItem);
        renderDrillDonut(paretoItem);
    }

    function renderDrillTrend(paretoItem) {
        const rng = seededRandom(paretoItem.defectCode.charCodeAt(0) * 100);
        const weeklyValues = WEEKS.map(() => Math.floor(30 + rng() * 250));
        const labels = WEEKS.map(w => w.weekShort);

        const cfg = {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: paretoItem.defectCode + ' Qty',
                    data: weeklyValues,
                    borderColor: COLORS.blue,
                    backgroundColor: 'rgba(37,99,235,0.08)',
                    borderWidth: 2,
                    pointRadius: 3,
                    pointBackgroundColor: '#fff',
                    pointBorderColor: COLORS.blue,
                    pointBorderWidth: 2,
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
                        backgroundColor: 'rgba(17,19,21,0.9)',
                        titleFont: { ...CHART_FONT, weight: '600' },
                        bodyFont: CHART_FONT,
                        padding: 8,
                        cornerRadius: 5,
                    },
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { font: { size: 10 } },
                    },
                    y: {
                        grid: { color: 'rgba(0,0,0,0.04)' },
                        ticks: { font: { size: 10 } },
                    },
                },
            },
        };

        if (drillTrendChart) drillTrendChart.destroy();
        drillTrendChart = new Chart(document.getElementById('drillTrendChart'), cfg);
    }

    function renderDrillDonut(paretoItem) {
        const rng = seededRandom(paretoItem.defectCode.charCodeAt(0) * 77);
        const deptValues = DEPARTMENTS.map(() => Math.floor(10 + rng() * 200));
        const total = deptValues.reduce((a, b) => a + b, 0);
        const deptPcts = deptValues.map(v => ((v / total) * 100).toFixed(1));

        const deptColors = [COLORS.blue, COLORS.orange, COLORS.green, COLORS.yellow, '#8b5cf6'];

        const cfg = {
            type: 'doughnut',
            data: {
                labels: DEPARTMENTS,
                datasets: [{
                    data: deptValues,
                    backgroundColor: deptColors,
                    borderColor: '#fff',
                    borderWidth: 2,
                    hoverOffset: 4,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '55%',
                plugins: {
                    legend: {
                        position: 'right',
                        labels: {
                            font: { size: 10, family: CHART_FONT.family, weight: '500' },
                            usePointStyle: true,
                            pointStyle: 'circle',
                            padding: 8,
                            boxWidth: 8,
                            generateLabels: function (chart) {
                                const data = chart.data;
                                return data.labels.map((label, i) => ({
                                    text: label + ' (' + deptPcts[i] + '%)',
                                    fillStyle: data.datasets[0].backgroundColor[i],
                                    strokeStyle: 'transparent',
                                    pointStyle: 'circle',
                                    index: i,
                                }));
                            },
                        },
                    },
                    tooltip: {
                        backgroundColor: 'rgba(17,19,21,0.9)',
                        titleFont: { ...CHART_FONT, weight: '600' },
                        bodyFont: CHART_FONT,
                        padding: 8,
                        cornerRadius: 5,
                        callbacks: {
                            label: function (ctx) {
                                const pct = deptPcts[ctx.dataIndex];
                                return ctx.label + ': ' + ctx.parsed.toLocaleString() + ' (' + pct + '%)';
                            },
                        },
                    },
                },
            },
        };

        if (drillDonutChart) drillDonutChart.destroy();
        drillDonutChart = new Chart(document.getElementById('drillDonutChart'), cfg);
    }

    /* --------------------------------------------------------
       5. MULTI-SELECT DROPDOWN COMPONENT
       -------------------------------------------------------- */
    let activeMultiSelect = null;
    let currentOptions = [];
    let currentSelection = [];

    function openMultiSelect(triggerEl, options, selected, onUpdate) {
        const dd = document.getElementById('msDropdown');
        const rect = triggerEl.getBoundingClientRect();
        dd.style.top = (rect.bottom + 4) + 'px';
        dd.style.left = rect.left + 'px';
        dd.style.width = Math.max(rect.width, 220) + 'px';
        dd.classList.remove('hidden');
        triggerEl.classList.add('open');

        currentOptions = options;
        currentSelection = [...selected];
        activeMultiSelect = { triggerEl, onUpdate };

        document.getElementById('msSearch').value = '';
        renderDropdownOptions('');
    }

    function closeMultiSelect() {
        const dd = document.getElementById('msDropdown');
        dd.classList.add('hidden');
        if (activeMultiSelect) {
            activeMultiSelect.triggerEl.classList.remove('open');
            activeMultiSelect = null;
        }
    }

    function renderDropdownOptions(search) {
        const container = document.getElementById('msOptions');
        const filtered = currentOptions.filter(o =>
            o.toLowerCase().includes(search.toLowerCase())
        );
        container.innerHTML = filtered.map(opt => `
            <label class="ms-option">
                <input type="checkbox" value="${opt}" ${currentSelection.includes(opt) ? 'checked' : ''}>
                ${opt}
            </label>
        `).join('');

        container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.addEventListener('change', () => {
                if (cb.checked) {
                    if (!currentSelection.includes(cb.value)) currentSelection.push(cb.value);
                } else {
                    currentSelection = currentSelection.filter(v => v !== cb.value);
                }
            });
        });
    }

    function applyMultiSelect() {
        if (!activeMultiSelect) return;
        const { triggerEl, onUpdate } = activeMultiSelect;
        onUpdate([...currentSelection]);
        const display = triggerEl.querySelector('.ms-display');
        if (currentSelection.length === currentOptions.length) {
            display.textContent = 'All Selected';
        } else if (currentSelection.length === 0) {
            display.textContent = 'None';
        } else if (currentSelection.length <= 2) {
            display.textContent = currentSelection.join(', ');
        } else {
            display.textContent = currentSelection.length + ' selected';
        }
        closeMultiSelect();
    }

    /* --------------------------------------------------------
       6. MAIN RENDER ORCHESTRATOR
       -------------------------------------------------------- */
    function showLoading(id) {
        const el = document.getElementById(id);
        if (el) el.classList.remove('hidden');
    }
    function hideLoading(id) {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    }
    function showEmpty(id) {
        const el = document.getElementById(id);
        if (el) el.classList.remove('hidden');
    }
    function hideEmpty(id) {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    }

    function renderAll() {
        showLoading('loadingTrend');
        showLoading('loadingPareto');
        hideEmpty('emptyTrend');
        hideEmpty('emptyPareto');

        setTimeout(function () {
            // Trend
            const summary = filterSummary();
            const weeklyData = aggregateWeekly(summary);
            hideLoading('loadingTrend');
            if (weeklyData.length === 0) {
                showEmpty('emptyTrend');
                document.getElementById('trendChartView').classList.add('hidden');
            } else {
                document.getElementById('trendChartView').classList.remove('hidden');
                renderTrendChart(weeklyData);
                fillTrendTable(weeklyData);
                // Default: select latest week
                const latest = weeklyData[weeklyData.length - 1];
                updateKPI(latest);
                highlightWeek(weeklyData.length - 1);
            }

            // Pareto
            const defectData = filterDefects();
            const paretoData = aggregateDefectPareto(defectData);
            hideLoading('loadingPareto');
            if (paretoData.length === 0) {
                showEmpty('emptyPareto');
                document.getElementById('paretoChartView').classList.add('hidden');
            } else {
                document.getElementById('paretoChartView').classList.remove('hidden');
                renderParetoChart(paretoData);
                // Reset drill-down
                selectedDefectIdx = null;
                document.getElementById('drillEmpty').classList.remove('hidden');
                document.getElementById('drillCharts').classList.add('hidden');
                document.getElementById('drillTitle').textContent = 'Select a defect';
            }
        }, 350);
    }

    /* --------------------------------------------------------
       7. EXPORT
       -------------------------------------------------------- */
    function exportCSV() {
        const summary = filterSummary();
        const weeklyData = aggregateWeekly(summary);
        const defectData = filterDefects();
        const paretoData = aggregateDefectPareto(defectData);

        let csv = 'QDM Finished Lot Yield Dashboard Export\n';
        csv += 'Customer: ' + filterState.customer.join('; ') + '\n';
        csv += 'Plant: ' + filterState.plant.join('; ') + '\n';
        csv += 'Lot Type: ' + filterState.lotType + '\n';
        csv += 'Unit Type: ' + filterState.unitType + '\n';
        csv += 'Project Type: ' + filterState.projectType + '\n';
        csv += 'Date Type: ' + filterState.dateType + '\n';
        csv += 'Exported: ' + new Date().toISOString() + '\n\n';

        csv += '--- Weekly Yield Summary ---\n';
        csv += 'Week ID,Label,Yield %,Target %,Output NSQM,Input Qty,NSQM Loss\n';
        weeklyData.forEach(d => {
            csv += [d.weekId, d.weekLabel, d.yield, TARGET, d.outputNSQM, d.inputQty, d.nsqmLoss].join(',') + '\n';
        });

        csv += '\n--- Defect Pareto (Top 15) ---\n';
        csv += 'Defect Code,Name,Department,Total Qty,Total Loss Ratio\n';
        paretoData.forEach(d => {
            csv += [d.defectCode, d.defectName, d.department, d.totalQty, d.totalLoss.toFixed(3)].join(',') + '\n';
        });

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'QDM_Yield_Dashboard_' + filterState.lotType + '_' + filterState.unitType + '.csv';
        a.click();
        URL.revokeObjectURL(url);
    }

    /* --------------------------------------------------------
       8. EVENT BINDINGS
       -------------------------------------------------------- */
    function init() {
        // Last Updated
        const now = new Date();
        document.getElementById('lastUpdated').textContent =
            now.getFullYear() + '-' +
            String(now.getMonth() + 1).padStart(2, '0') + '-' +
            String(now.getDate()).padStart(2, '0') + ' ' +
            String(now.getHours()).padStart(2, '0') + ':' +
            String(now.getMinutes()).padStart(2, '0');

        // Multi-select: Customer
        document.getElementById('triggerCustomer').addEventListener('click', function (e) {
            e.stopPropagation();
            if (activeMultiSelect && activeMultiSelect.triggerEl === this) {
                closeMultiSelect();
            } else {
                openMultiSelect(this, CUSTOMERS, filterState.customer, function (sel) {
                    filterState.customer = sel;
                    renderAll();
                });
            }
        });

        // Multi-select: Plant
        document.getElementById('triggerPlant').addEventListener('click', function (e) {
            e.stopPropagation();
            if (activeMultiSelect && activeMultiSelect.triggerEl === this) {
                closeMultiSelect();
            } else {
                openMultiSelect(this, PLANTS, filterState.plant, function (sel) {
                    filterState.plant = sel;
                    renderAll();
                });
            }
        });

        // Search
        document.getElementById('msSearch').addEventListener('input', function () {
            renderDropdownOptions(this.value);
        });

        // Select All
        document.getElementById('msSelectAll').addEventListener('click', function () {
            currentSelection = [...currentOptions];
            renderDropdownOptions(document.getElementById('msSearch').value);
        });

        // Apply
        document.getElementById('msApply').addEventListener('click', function () {
            applyMultiSelect();
        });

        // Click outside closes dropdown
        document.addEventListener('click', function (e) {
            if (activeMultiSelect && !document.getElementById('msDropdown').contains(e.target)) {
                closeMultiSelect();
            }
        });

        // Single select filters
        document.getElementById('filterDateType').addEventListener('change', function () {
            filterState.dateType = this.value;
            renderAll();
        });
        document.getElementById('filterLotType').addEventListener('change', function () {
            filterState.lotType = this.value;
            renderAll();
        });
        document.getElementById('filterUnitType').addEventListener('change', function () {
            filterState.unitType = this.value;
            renderAll();
        });
        document.getElementById('filterProjectType').addEventListener('change', function () {
            filterState.projectType = this.value;
            renderAll();
        });

        // View toggle
        document.getElementById('btnChartView').addEventListener('click', function () {
            this.classList.add('active');
            document.getElementById('btnTableView').classList.remove('active');
            document.getElementById('trendChartView').classList.remove('hidden');
            document.getElementById('trendTableView').classList.add('hidden');
        });
        document.getElementById('btnTableView').addEventListener('click', function () {
            this.classList.add('active');
            document.getElementById('btnChartView').classList.remove('active');
            document.getElementById('trendChartView').classList.add('hidden');
            document.getElementById('trendTableView').classList.remove('hidden');
        });

        // Export
        document.getElementById('btnExport').addEventListener('click', exportCSV);

        // Initial render
        renderAll();
    }

    // Start
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
