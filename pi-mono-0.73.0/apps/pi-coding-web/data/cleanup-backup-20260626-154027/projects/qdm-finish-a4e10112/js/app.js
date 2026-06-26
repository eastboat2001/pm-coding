/**
 * QDM Finished Lot 良率看板 - 主应用逻辑
 * 处理筛选、数据加载、图表初始化、交互联动
 */

// ==================== 应用状态 ====================
const AppState = {
    filters: { customers: [], plants: [], dateType: 'Weekly', lotType: 'HVM', unitType: 'NSQM', projectType: 'Overall' },
    selectedWeek: null,
    selectedDefectCode: null,
    charts: { yieldTrend: null, defectPareto: null, departmentDonut: null, defectTrend: null },
    currentPage: null // 'overview' | 'defect'
};

// ==================== 数据加载器 (模拟 API 层) ====================
const DataLoader = {
    delay: ms => new Promise(r => setTimeout(r, ms)),

    getFilters: async function() {
        await DataLoader.delay(200);
        return MockData.filters;
    },

    getYieldTrend: async function(filters) {
        await DataLoader.delay(400);
        let data = MockData.yieldTrend.map(d => ({ ...d }));
        if (filters.lotType && filters.lotType !== 'All') data = data.filter(d => d.lotType === filters.lotType);
        if (filters.unitType && filters.unitType !== 'All') data = data.filter(d => d.unitType === filters.unitType);
        if (filters.projectType && filters.projectType !== 'All') data = data.filter(d => d.projectType === filters.projectType);
        return data;
    },

    getDefectAnalysis: async function(filters) {
        await DataLoader.delay(500);
        return MockData.defectAnalysis.map(d => ({ ...d }));
    },

    getDepartmentDistribution: async function() {
        await DataLoader.delay(300);
        return MockData.departmentDistribution.map(d => ({ ...d }));
    },

    getDefectTrend: async function() {
        await DataLoader.delay(400);
        return MockData.defectTrend.map(d => ({ ...d }));
    },

    exportData: async function(filters, type) {
        await DataLoader.delay(600);
        return { filters, exportDate: new Date().toISOString(), type, records: MockData.yieldTrend };
    }
};

// ==================== UI 控制器 ====================
const UIController = {

    /* ---------- 筛选器初始化 ---------- */
    initFilters: function() {
        const f = MockData.filters;

        const customerSelect = document.getElementById('customerFilter');
        if (customerSelect) {
            customerSelect.innerHTML = '<option value="all">All Customers</option>';
            f.customers.forEach(c => {
                const o = document.createElement('option');
                o.value = c; o.textContent = c; o.selected = true;
                customerSelect.appendChild(o);
            });
        }

        const plantSelect = document.getElementById('plantFilter');
        if (plantSelect) {
            plantSelect.innerHTML = '<option value="all">All Plants</option>';
            f.plants.forEach(p => {
                const o = document.createElement('option');
                o.value = p; o.textContent = p; o.selected = true;
                plantSelect.appendChild(o);
            });
        }

        this._fillSelect('dateTypeFilter', f.dateTypes, 'Weekly');
        this._fillSelect('lotTypeFilter', f.lotTypes, 'HVM');
        this._fillSelect('unitTypeFilter', f.unitTypes, 'NSQM');
        this._fillSelect('projectTypeFilter', f.projectTypes, 'Overall');
    },

    _fillSelect: function(id, options, defaultVal) {
        const el = document.getElementById(id);
        if (!el) return;
        el.innerHTML = '';
        options.forEach(v => {
            const o = document.createElement('option');
            o.value = v; o.textContent = v; o.selected = (v === defaultVal);
            el.appendChild(o);
        });
    },

    getCurrentFilters: function() {
        return {
            customers: Array.from(document.getElementById('customerFilter')?.selectedOptions || []).map(o => o.value),
            plants: Array.from(document.getElementById('plantFilter')?.selectedOptions || []).map(o => o.value),
            dateType: document.getElementById('dateTypeFilter')?.value || 'Weekly',
            lotType: document.getElementById('lotTypeFilter')?.value || 'HVM',
            unitType: document.getElementById('unitTypeFilter')?.value || 'NSQM',
            projectType: document.getElementById('projectTypeFilter')?.value || 'Overall'
        };
    },

    updateFilterStatus: function(filters) {
        const el = document.getElementById('filterStatus');
        if (el) {
            const parts = [];
            if (filters.dateType) parts.push('Date: ' + filters.dateType);
            if (filters.lotType) parts.push('Lot: ' + filters.lotType);
            if (filters.unitType) parts.push('Unit: ' + filters.unitType);
            if (filters.projectType) parts.push('Project: ' + filters.projectType);
            el.textContent = parts.join(' | ');
        }
    },

    showLoading: function() {
        document.querySelectorAll('.loading-overlay').forEach(o => o.classList.add('active'));
    },
    hideLoading: function() {
        document.querySelectorAll('.loading-overlay').forEach(o => o.classList.remove('active'));
    },

    showEmptyState: function(containerId) {
        const c = document.getElementById(containerId);
        if (c) {
            c.innerHTML = '<div class="chart-empty-state"><i class="fas fa-chart-line"></i><p>No Data Found</p><span>Try adjusting your filter criteria</span></div>';
        }
    },

    showError: function(containerId, message) {
        const c = document.getElementById(containerId);
        if (c) {
            c.innerHTML = '<div class="chart-empty-state"><i class="fas fa-exclamation-triangle"></i><p>Error Loading Data</p><span>' + (message || 'Please try again later') + '</span></div>';
        }
    },

    updateLastRefreshTime: function() {
        const el = document.getElementById('lastRefreshTime');
        if (el) el.textContent = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
    },

    initTooltips: function() {
        document.querySelectorAll('[data-tooltip]').forEach(trigger => {
            const tip = document.createElement('div');
            tip.className = 'tooltip';
            tip.textContent = trigger.getAttribute('data-tooltip');
            trigger.appendChild(tip);
            trigger.addEventListener('mouseenter', () => tip.classList.add('show'));
            trigger.addEventListener('mouseleave', () => tip.classList.remove('show'));
        });
    },

    exportData: async function(type) {
        UIController.showLoading();
        try {
            const filters = UIController.getCurrentFilters();
            const data = await DataLoader.exportData(filters, type);
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'qdm-yield-report-' + type.toLowerCase() + '-' + new Date().toISOString().split('T')[0] + '.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            alert('Report exported as ' + type);
        } catch (e) {
            alert('Export failed: ' + e.message);
        } finally {
            UIController.hideLoading();
        }
    }
};

// ==================== 主应用 ====================
const App = {
    init: async function() {
        console.log('Initializing QDM Finished Lot Yield Dashboard...');
        AppState.currentPage = document.body.getAttribute('data-page') || 'overview';

        UIController.initFilters();
        App.bindFilterEvents();
        App.bindExportEvents();
        App.bindCustomEvents();
        UIController.updateLastRefreshTime();
        UIController.initTooltips();
        await App.loadInitialData();
        console.log('Dashboard initialized');
    },

    bindFilterEvents: function() {
        document.querySelectorAll('.form-select').forEach(el => {
            el.addEventListener('change', () => App.handleFilterChange());
        });
        const refreshBtn = document.getElementById('refreshBtn');
        if (refreshBtn) refreshBtn.addEventListener('click', () => App.handleFilterChange());
    },

    bindExportEvents: function() {
        const csvBtn = document.getElementById('exportCsvBtn');
        const excelBtn = document.getElementById('exportExcelBtn');
        if (csvBtn) csvBtn.addEventListener('click', () => UIController.exportData('CSV'));
        if (excelBtn) excelBtn.addEventListener('click', () => UIController.exportData('Excel'));
    },

    bindCustomEvents: function() {
        document.addEventListener('weekSelected', e => {
            console.log('Week selected:', e.detail.week);
            AppState.selectedWeek = e.detail.week;
            App.loadWeekDetails(e.detail.week);
        });
        document.addEventListener('defectSelected', e => {
            console.log('Defect selected:', e.detail.defectCode);
            AppState.selectedDefectCode = e.detail.defectCode;
            App.loadDefectDetails(e.detail.defectCode);
        });
        document.addEventListener('departmentSelected', e => {
            console.log('Department selected:', e.detail.department);
        });
    },

    handleFilterChange: async function() {
        console.log('Filters changed, reloading...');
        UIController.showLoading();
        try {
            const filters = UIController.getCurrentFilters();
            UIController.updateFilterStatus(filters);
            await App.loadData(filters);
            UIController.updateLastRefreshTime();
        } catch (e) {
            console.error('Filter change error:', e);
        } finally {
            UIController.hideLoading();
        }
    },

    loadInitialData: async function() {
        UIController.showLoading();
        try {
            await App.loadData(UIController.getCurrentFilters());
        } catch (e) {
            console.error('Initial load error:', e);
        } finally {
            UIController.hideLoading();
        }
    },

    loadData: async function(filters) {
        if (AppState.currentPage === 'overview') await App.loadOverviewData(filters);
        else if (AppState.currentPage === 'defect') await App.loadDefectData(filters);
    },

    /* ---------- 总览页面 ---------- */
    loadOverviewData: async function(filters) {
        try {
            const trendData = await DataLoader.getYieldTrend(filters);
            if (trendData.length === 0) { UIController.showEmptyState('yieldTrendChartContainer'); return; }

            const ctx = document.getElementById('yieldTrendChart');
            if (ctx) {
                if (AppState.charts.yieldTrend) AppState.charts.yieldTrend.destroy();
                AppState.charts.yieldTrend = ChartConfig.createYieldTrendChart(ctx, trendData);
            }
            App.updateKPICards(trendData);
        } catch (e) {
            console.error('Overview load error:', e);
            UIController.showError('yieldTrendChartContainer', e.message);
        }
    },

    updateKPICards: function(data) {
        if (!data.length) return;
        const latest = data[data.length - 1];
        const targetYield = 96.5;
        const yieldDiff = latest.yield - targetYield;

        const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        const setClass = (id, cls) => { const el = document.getElementById(id); if (el) el.className = cls; };

        setText('yieldValue', latest.yield.toFixed(2) + '%');
        setText('yieldDiff', (yieldDiff >= 0 ? '+' : '') + yieldDiff.toFixed(2) + '%');
        setClass('yieldDiff', yieldDiff >= 0 ? 'kpi-change positive' : 'kpi-change negative');

        setText('outputValue', latest.outputNSQM.toLocaleString());
        setText('finishedCountValue', latest.finishedCount.toLocaleString());
        setText('lossValue', latest.lossNSQM.toLocaleString());

        if (data.length >= 2) {
            const prev = data[data.length - 2];
            const outputChange = ((latest.outputNSQM - prev.outputNSQM) / prev.outputNSQM * 100).toFixed(1);
            const outputTrendEl = document.getElementById('outputTrend');
            if (outputTrendEl) {
                outputTrendEl.textContent = (outputChange >= 0 ? '↑' : '↓') + ' ' + Math.abs(outputChange) + '% vs last week';
                outputTrendEl.className = outputChange >= 0 ? 'kpi-trend positive' : 'kpi-trend negative';
            }

            const finishedChange = ((latest.finishedCount - prev.finishedCount) / prev.finishedCount * 100).toFixed(1);
            const finishedTrendEl = document.getElementById('finishedCountTrend');
            if (finishedTrendEl) {
                finishedTrendEl.textContent = (finishedChange >= 0 ? '↑' : '↓') + ' ' + Math.abs(finishedChange) + '% vs last week';
                finishedTrendEl.className = finishedChange >= 0 ? 'kpi-trend positive' : 'kpi-trend negative';
            }
        }
    },

    /* ---------- 缺陷分析页面 ---------- */
    loadDefectData: async function(filters) {
        try {
            const defectData = await DataLoader.getDefectAnalysis(filters);
            if (defectData.length === 0) {
                UIController.showEmptyState('defectParetoChartContainer');
                UIController.showEmptyState('defectTrendChartContainer');
                return;
            }

            // Pareto 图
            const paretoCtx = document.getElementById('defectParetoChart');
            if (paretoCtx) {
                if (AppState.charts.defectPareto) AppState.charts.defectPareto.destroy();
                AppState.charts.defectPareto = ChartConfig.createDefectParetoChart(paretoCtx, defectData);
            }

            // 部门分布
            const deptData = await DataLoader.getDepartmentDistribution();
            const deptCtx = document.getElementById('departmentDonutChart');
            if (deptCtx) {
                if (AppState.charts.departmentDonut) AppState.charts.departmentDonut.destroy();
                AppState.charts.departmentDonut = ChartConfig.createDepartmentDonutChart(deptCtx, deptData);
            }

            // 缺陷统计
            App.updateDefectStats(defectData, deptData);

            // 缺陷趋势
            const trendData = await DataLoader.getDefectTrend();
            const trendCtx = document.getElementById('defectTrendChart');
            if (trendCtx) {
                if (AppState.charts.defectTrend) AppState.charts.defectTrend.destroy();
                AppState.charts.defectTrend = ChartConfig.createDefectTrendChart(trendCtx, trendData, null);
            }
        } catch (e) {
            console.error('Defect data load error:', e);
            UIController.showError('defectParetoChartContainer', e.message);
        }
    },

    updateDefectStats: function(defectData, deptData) {
        if (!defectData.length) return;
        const totalDefects = defectData.reduce((s, d) => s + parseInt(d.qty), 0);
        const top5Loss = defectData.slice(0, 5).reduce((s, d) => s + parseFloat(d.lossRatio), 0);
        const topDept = deptData.length > 0 ? deptData[0].department : 'N/A';

        const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        setText('totalDefects', totalDefects.toLocaleString());
        setText('coreLossRatio', top5Loss.toFixed(2) + '%');
        setText('topDepartment', topDept);
    },

    /* ---------- 周/缺陷 下钻 ---------- */
    loadWeekDetails: async function(week) {
        const weekTitle = document.getElementById('selectedWeekTitle');
        if (weekTitle) weekTitle.textContent = week + ' Details';

        const weekData = MockData.yieldTrend.find(d => d.week === week);
        const container = document.getElementById('weekDetailsContainer');
        if (!container || !weekData) return;
        container.innerHTML =
            '<div class="detail-row"><span class="detail-label">Yield:</span><span class="detail-value">' + weekData.yield + '%</span></div>' +
            '<div class="detail-row"><span class="detail-label">Output:</span><span class="detail-value">' + weekData.outputNSQM.toLocaleString() + ' NSQM</span></div>' +
            '<div class="detail-row"><span class="detail-label">Defects:</span><span class="detail-value">' + weekData.defects.reduce((s,d) => s + d.qty, 0) + ' units</span></div>' +
            '<div class="detail-row"><span class="detail-label">Loss:</span><span class="detail-value">' + weekData.lossNSQM.toLocaleString() + ' NSQM</span></div>';
    },

    loadDefectDetails: async function(defectCode) {
        const title = document.getElementById('selectedDefectTitle');
        if (title) title.textContent = defectCode + ' Details';

        // 更新缺陷详情卡片
        const defectInfo = MockData.defectAnalysis.find(d => d.code === defectCode);
        const container = document.getElementById('defectDetailsContainer');
        if (container && defectInfo) {
            container.innerHTML =
                '<div class="detail-row"><span class="detail-label">Defect Code:</span><span class="detail-value">' + defectInfo.code + '</span></div>' +
                '<div class="detail-row"><span class="detail-label">Quantity:</span><span class="detail-value">' + defectInfo.qty + ' units</span></div>' +
                '<div class="detail-row"><span class="detail-label">Loss Ratio:</span><span class="detail-value">' + defectInfo.lossRatio + '%</span></div>' +
                '<div class="detail-row"><span class="detail-label">Department:</span><span class="detail-value">' + defectInfo.department + '</span></div>';
        }

        // 更新缺陷趋势图（高亮选中的缺陷）
        const trendData = await DataLoader.getDefectTrend();
        const trendCtx = document.getElementById('defectTrendChart');
        if (trendCtx) {
            if (AppState.charts.defectTrend) AppState.charts.defectTrend.destroy();
            AppState.charts.defectTrend = ChartConfig.createDefectTrendChart(trendCtx, trendData, defectCode);
        }
    }
};

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => App.init());
