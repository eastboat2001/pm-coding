/**
 * QDM Finished Lot Yield Dashboard - Main Application
 */

// Global state
const AppState = {
    filters: {
        customer: 'all',
        plant: 'all',
        dateType: 'Weekly',
        lotType: 'HVM',
        unitType: 'NSQM',
        projectType: 'Overall'
    },
    selectedWeek: null,
    selectedDefectCode: null,
    charts: {
        yieldTrend: null,
        defectPareto: null,
        defectTrend: null,
        departmentDonut: null,
        yieldBreakdown: null
    },
    lastUpdated: null
};

// Initialize the application
document.addEventListener('DOMContentLoaded', function() {
    initApp();
});

function initApp() {
    console.log('Initializing QDM Yield Dashboard...');
    
    // Set last updated time
    AppState.lastUpdated = new Date().toISOString();
    updateLastUpdatedDisplay();
    
    // Initialize filters
    initFilters();
    
    // Initialize charts
    initCharts();
    
    // Initialize event listeners
    initEventListeners();
    
    // Set default selection (latest week)
    if (YieldData.weeklyTrend.length > 0) {
        selectWeek(YieldData.weeklyTrend.length - 1);
    }
    
    // Set default defect selection
    if (DefectData.pareto.length > 0) {
        selectDefectCode(DefectData.pareto[0].code);
    }
    
    console.log('Dashboard initialized successfully');
}

// Update last updated display
function updateLastUpdatedDisplay() {
    const el = document.getElementById('lastUpdated');
    if (el && AppState.lastUpdated) {
        const date = new Date(AppState.lastUpdated);
        el.textContent = date.toLocaleString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }
}

// Initialize filter dropdowns
function initFilters() {
    console.log('Initializing filters...');
    // Filters are already set with default values in HTML
    // This function can be extended to populate dynamic options
}

// Initialize all charts
function initCharts() {
    console.log('Initializing charts...');
    
    // CH-01: Yield Trend Chart
    initYieldTrendChart();
    
    // CH-02: Defect Pareto Chart
    initDefectParetoChart();
    
    // Initialize detail charts (hidden initially)
    initDetailCharts();
}

// Initialize Yield Trend Chart
function initYieldTrendChart() {
    const container = document.getElementById('yieldTrendChart');
    if (!container) {
        console.error('Yield trend chart container not found');
        return;
    }
    
    AppState.charts.yieldTrend = echarts.init(container);
    
    const option = ChartConfig.createYieldTrendChart(YieldData.weeklyTrend);
    AppState.charts.yieldTrend.setOption(option);
    
    // Add click handler
    AppState.charts.yieldTrend.on('click', function(params) {
        if (params.seriesType === 'bar') {
            selectWeek(params.dataIndex);
        }
    });
    
    console.log('Yield trend chart initialized');
}

// Initialize Defect Pareto Chart
function initDefectParetoChart() {
    const container = document.getElementById('defectParetoChart');
    if (!container) {
        console.error('Defect pareto chart container not found');
        return;
    }
    
    AppState.charts.defectPareto = echarts.init(container);
    
    const option = ChartConfig.createDefectParetoChart(DefectData.pareto);
    AppState.charts.defectPareto.setOption(option);
    
    // Add click handler
    AppState.charts.defectPareto.on('click', function(params) {
        if (params.componentType === 'series') {
            selectDefectCode(params.name || DefectData.pareto[params.dataIndex].code);
        }
    });
    
    console.log('Defect pareto chart initialized');
}

// Initialize detail charts (right panel)
function initDetailCharts() {
    // Defect Trend Chart
    const trendContainer = document.getElementById('defectTrendChart');
    if (trendContainer) {
        AppState.charts.defectTrend = echarts.init(trendContainer);
    }
    
    // Department Donut Chart
    const donutContainer = document.getElementById('departmentDonutChart');
    if (donutContainer) {
        AppState.charts.departmentDonut = echarts.init(donutContainer);
    }
    
    // Yield Breakdown Chart
    const breakdownContainer = document.getElementById('yieldBreakdownChart');
    if (breakdownContainer) {
        AppState.charts.yieldBreakdown = echarts.init(breakdownContainer);
    }
    
    console.log('Detail charts initialized');
}

// Initialize event listeners
function initEventListeners() {
    console.log('Initializing event listeners...');
    
    // Filter change handlers
    document.getElementById('customerFilter')?.addEventListener('change', handleFilterChange);
    document.getElementById('plantFilter')?.addEventListener('change', handleFilterChange);
    document.getElementById('dateTypeFilter')?.addEventListener('change', handleFilterChange);
    document.getElementById('lotTypeFilter')?.addEventListener('change', handleFilterChange);
    document.getElementById('unitTypeFilter')?.addEventListener('change', handleFilterChange);
    document.getElementById('projectTypeFilter')?.addEventListener('change', handleFilterChange);
    
    // Export button
    document.getElementById('exportBtn')?.addEventListener('click', handleExport);
    
    // Window resize handler
    window.addEventListener('resize', handleResize);
    
    console.log('Event listeners initialized');
}

// Handle filter changes
function handleFilterChange(event) {
    const filterId = event.target.id;
    const value = event.target.value;
    
    // Update app state
    const filterKey = filterId.replace('Filter', '');
    AppState.filters[filterKey] = value;
    
    console.log(`Filter changed: ${filterKey} = ${value}`);
    
    // Update charts with new filter
    updateChartsWithFilters();
}

// Update charts based on current filters
function updateChartsWithFilters() {
    console.log('Updating charts with filters:', AppState.filters);
    
    // In a real app, this would call the API
    // For mock data, we just re-render with current data
    refreshAllCharts();
}

// Refresh all charts
function refreshAllCharts() {
    // Refresh yield trend
    if (AppState.charts.yieldTrend) {
        const option = ChartConfig.createYieldTrendChart(
            YieldData.weeklyTrend,
            AppState.selectedWeek
        );
        AppState.charts.yieldTrend.setOption(option);
    }
    
    // Refresh defect pareto
    if (AppState.charts.defectPareto) {
        const option = ChartConfig.createDefectParetoChart(
            DefectData.pareto,
            AppState.selectedDefectCode
        );
        AppState.charts.defectPareto.setOption(option);
    }
    
    // Refresh detail charts
    refreshDetailCharts();
}

// Select a week (for detail panel)
function selectWeek(index) {
    console.log('Selected week index:', index);
    AppState.selectedWeek = index;
    
    // Update KPI cards
    updateKPICards(index);
    
    // Update yield breakdown chart
    updateYieldBreakdownChart(index);
    
    // Refresh trend chart to highlight selected bar
    if (AppState.charts.yieldTrend) {
        const option = ChartConfig.createYieldTrendChart(
            YieldData.weeklyTrend,
            index
        );
        AppState.charts.yieldTrend.setOption(option);
    }
    
    // Show selected state on bars
    document.querySelectorAll('.week-bar').forEach((bar, i) => {
        if (i === index) {
            bar.classList.add('selected');
        } else {
            bar.classList.remove('selected');
        }
    });
}

// Update KPI cards for selected week
function updateKPICards(weekIndex) {
    const weekData = YieldData.weeklyTrend[weekIndex];
    if (!weekData) return;
    
    // Yield card
    document.getElementById('yieldValue').textContent = weekData.yield.toFixed(2) + '%';
    document.getElementById('yieldTarget').textContent = `Target: ${weekData.target.toFixed(2)}%`;
    
    const yieldDiff = weekData.yield - weekData.target;
    const yieldStatus = document.getElementById('yieldStatus');
    if (yieldDiff >= 0) {
        yieldStatus.textContent = `+${yieldDiff.toFixed(2)}% vs target`;
        yieldStatus.className = 'kpi-change positive';
    } else {
        yieldStatus.textContent = `${yieldDiff.toFixed(2)}% vs target`;
        yieldStatus.className = 'kpi-change negative';
    }
    
    // Output card
    document.getElementById('outputValue').textContent = weekData.output + ' lots';
    document.getElementById('outputChange').textContent = `NSQM: ${weekData.outputNSQM || weekData.output}`;
    
    // Finished Count card
    document.getElementById('finishedValue').textContent = weekData.finishedCount + ' lots';
    document.getElementById('finishedChange').textContent = `Output/Input: ${(weekData.outputRatio * 100).toFixed(1)}%`;
    
    // Loss card
    document.getElementById('lossValue').textContent = weekData.loss + '%';
    document.getElementById('lossChange').textContent = `Target: < ${(100 - weekData.target).toFixed(2)}%`;
}

// Update yield breakdown chart
function updateYieldBreakdownChart(weekIndex) {
    const container = document.getElementById('yieldBreakdownChart');
    if (!container || !AppState.charts.yieldBreakdown) return;
    
    // Get process yields for selected week
    const weekData = YieldData.weeklyTrend[weekIndex];
    const processData = YieldData.processBreakdown[weekIndex] || YieldData.processBreakdown[0];
    
    const option = ChartConfig.createYieldBreakdownChart({
        processes: processData.processes,
        yields: processData.yields
    });
    
    AppState.charts.yieldBreakdown.setOption(option);
}

// Select a defect code (for detail panel)
function selectDefectCode(code) {
    console.log('Selected defect code:', code);
    AppState.selectedDefectCode = code;
    
    // Update defect detail section
    updateDefectDetailSection(code);
    
    // Refresh pareto chart to highlight selected code
    if (AppState.charts.defectPareto) {
        const option = ChartConfig.createDefectParetoChart(
            DefectData.pareto,
            code
        );
        AppState.charts.defectPareto.setOption(option);
    }
}

// Update defect detail section
function updateDefectDetailSection(code) {
    // Get defect data
    const defect = DefectData.pareto.find(d => d.code === code);
    if (!defect) return;
    
    // Update defect code label
    document.getElementById('selectedDefectCode').textContent = code;
    
    // Update defect trend chart
    updateDefectTrendChart(code);
    
    // Update department donut chart
    updateDepartmentDonutChart(code);
    
    // Update defect info
    document.getElementById('defectTotalLoss').textContent = defect.totalRatio + '%';
    document.getElementById('defectCoreLoss').textContent = defect.coreRatio + '%';
    document.getElementById('defectQty').textContent = defect.qty + ' units';
}

// Update defect trend chart
function updateDefectTrendChart(code) {
    const container = document.getElementById('defectTrendChart');
    if (!container || !AppState.charts.defectTrend) return;
    
    const trendData = DefectData.trends[code];
    if (!trendData) return;
    
    const weekLabels = YieldData.weeklyTrend.map(d => d.week);
    
    const option = ChartConfig.createDefectTrendChart(code, trendData, weekLabels);
    AppState.charts.defectTrend.setOption(option);
}

// Update department donut chart
function updateDepartmentDonutChart(code) {
    const container = document.getElementById('departmentDonutChart');
    if (!container || !AppState.charts.departmentDonut) return;
    
    const departments = DefectData.departments[code];
    if (!departments) return;
    
    const option = ChartConfig.createDepartmentDonutChart(departments);
    AppState.charts.departmentDonut.setOption(option);
}

// Handle window resize
function handleResize() {
    console.log('Window resized, updating charts...');
    
    // Resize all charts
    Object.values(AppState.charts).forEach(chart => {
        if (chart && chart.resize) {
            chart.resize();
        }
    });
}

// Handle export
function handleExport() {
    console.log('Exporting data...');
    
    // Build export data
    const exportData = {
        title: 'QDM Finished Lot Yield Dashboard',
        exportDate: new Date().toISOString(),
        filters: { ...AppState.filters },
        summary: {
            selectedWeek: AppState.selectedWeek !== null ? 
                YieldData.weeklyTrend[AppState.selectedWeek].week : 'N/A',
            yield: AppState.selectedWeek !== null ? 
                YieldData.weeklyTrend[AppState.selectedWeek].yield : 0,
            output: AppState.selectedWeek !== null ? 
                YieldData.weeklyTrend[AppState.selectedWeek].output : 0
        },
        weeklyTrend: YieldData.weeklyTrend,
        defectPareto: DefectData.pareto
    };
    
    // Convert to CSV
    const csv = convertToCSV(exportData);
    
    // Download
    downloadCSV(csv, 'QDM_Yield_Dashboard_Export.csv');
    
    // Show success message
    showExportSuccess();
}

// Convert data to CSV
function convertToCSV(data) {
    let csv = 'QDM Finished Lot Yield Dashboard Export\n';
    csv += `Export Date: ${new Date().toLocaleString()}\n`;
    csv += `Filters: Customer=${data.filters.customer}, Plant=${data.filters.plant}, `;
    csv += `DateType=${data.filters.dateType}, LotType=${data.filters.lotType}, `;
    csv += `UnitType=${data.filters.unitType}, ProjectType=${data.filters.projectType}\n`;
    csv += '\n';
    
    // Weekly Trend
    csv += 'Weekly Trend Data\n';
    csv += 'Week,Yield (%),Target (%),Output (lots),Finished Count,Loss (%)\n';
    data.weeklyTrend.forEach(week => {
        csv += `${week.week},${week.yield},${week.target},${week.output},${week.finishedCount},${week.loss}\n`;
    });
    csv += '\n';
    
    // Defect Pareto
    csv += 'Defect Pareto Data\n';
    csv += 'Defect Code,Total Loss Ratio (%),Core Loss Ratio (%),Quantity\n';
    data.defectPareto.forEach(defect => {
        csv += `${defect.code},${defect.totalRatio},${defect.coreRatio},${defect.qty}\n`;
    });
    
    return csv;
}

// Download CSV file
function downloadCSV(csv, filename) {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Show export success message
function showExportSuccess() {
    // Create toast notification
    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.innerHTML = `
        <span class="toast-icon">✓</span>
        <span class="toast-message">Export completed successfully</span>
    `;
    
    document.body.appendChild(toast);
    
    // Animate in
    setTimeout(() => toast.classList.add('show'), 10);
    
    // Remove after 3 seconds
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}
