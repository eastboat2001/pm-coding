/**
 * QDM Finished Lot 良率看板 - 图表配置
 * 使用 Chart.js 实现图表渲染
 */

const ChartConfig = {
    // AITC 配色
    colors: {
        primary: '#2563eb',
        secondary: '#1e40af',
        success: '#16a34a',
        warning: '#f59e0b',
        danger: '#c2413b',
        info: '#0891b2',
        gray: '#6b7280',
        lightGray: '#e5e7eb',
        background: '#f6f8fb'
    },

    // 图表默认选项
    defaultOptions: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 600 },
        plugins: {
            legend: {
                position: 'bottom',
                labels: {
                    font: { size: 12, family: 'Inter, system-ui, sans-serif' },
                    padding: 15,
                    usePointStyle: true
                }
            },
            tooltip: {
                backgroundColor: 'rgba(0,0,0,0.8)',
                titleFont: { size: 13, weight: '600' },
                bodyFont: { size: 12 },
                padding: 12,
                cornerRadius: 6,
                displayColors: true
            }
        },
        scales: {
            x: { grid: { display: false }, ticks: { font: { size: 11 } } },
            y: { grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { font: { size: 11 } } }
        }
    },

    /* ===== CH-01: 成品良率总趋势 (折线+柱状) ===== */
    createYieldTrendChart: function(ctx, data) {
        const labels = data.map(d => d.week);
        const yieldData = data.map(d => d.yield);
        const outputData = data.map(d => d.outputNSQM / 1000);

        return new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Yield (%)',
                        data: yieldData,
                        type: 'line',
                        borderColor: ChartConfig.colors.primary,
                        backgroundColor: ChartConfig.colors.primary + '20',
                        borderWidth: 3,
                        pointRadius: 5,
                        pointHoverRadius: 7,
                        pointBackgroundColor: ChartConfig.colors.primary,
                        pointBorderColor: '#fff',
                        pointBorderWidth: 2,
                        tension: 0.3,
                        yAxisID: 'y',
                        order: 0
                    },
                    {
                        label: 'Output (K NSQM)',
                        data: outputData,
                        backgroundColor: ChartConfig.colors.primary + '60',
                        borderColor: ChartConfig.colors.primary,
                        borderWidth: 1,
                        borderRadius: 4,
                        yAxisID: 'y1',
                        order: 1
                    }
                ]
            },
            options: {
                ...ChartConfig.defaultOptions,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    ...ChartConfig.defaultOptions.plugins,
                    tooltip: {
                        ...ChartConfig.defaultOptions.plugins.tooltip,
                        callbacks: {
                            label: function(ctx) {
                                const prefix = ctx.dataset.label + ': ';
                                if (ctx.datasetIndex === 0) return prefix + ctx.parsed.y.toFixed(2) + '%';
                                return prefix + ctx.parsed.y.toFixed(1) + 'K';
                            }
                        }
                    }
                },
                scales: {
                    x: { ...ChartConfig.defaultOptions.scales.x, title: { display: true, text: 'Week', font: { size: 12, weight: '600' } } },
                    y: {
                        ...ChartConfig.defaultOptions.scales.y,
                        type: 'linear', display: true, position: 'left',
                        title: { display: true, text: 'Yield (%)', font: { size: 12, weight: '600' } },
                        min: 85, max: 100,
                        ticks: { callback: v => v + '%' }
                    },
                    y1: {
                        ...ChartConfig.defaultOptions.scales.y,
                        type: 'linear', display: true, position: 'right',
                        title: { display: true, text: 'Output (K NSQM)', font: { size: 12, weight: '600' } },
                        grid: { drawOnChartArea: false }
                    }
                },
                onClick: function(event, elements) {
                    if (elements.length > 0) {
                        const idx = elements[0].index;
                        document.dispatchEvent(new CustomEvent('weekSelected', { detail: { week: data[idx].week } }));
                    }
                }
            }
        });
    },

    /* ===== CH-02: 缺陷损失排名 (横向柱状 + 累计线) ===== */
    createDefectParetoChart: function(ctx, data) {
        const labels = data.map(d => d.code);
        const lossData = data.map(d => parseFloat(d.lossRatio));
        const cumulative = [];
        let cum = 0;
        lossData.forEach(v => { cum += v; cumulative.push(parseFloat(cum.toFixed(2))); });

        return new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Loss Ratio (%)',
                        data: lossData,
                        backgroundColor: ChartConfig.colors.danger + '80',
                        borderColor: ChartConfig.colors.danger,
                        borderWidth: 1, borderRadius: 4,
                        yAxisID: 'y', order: 1
                    },
                    {
                        label: 'Cumulative (%)',
                        data: cumulative,
                        type: 'line',
                        borderColor: ChartConfig.colors.primary,
                        backgroundColor: ChartConfig.colors.primary + '20',
                        borderWidth: 3,
                        pointRadius: 5, pointHoverRadius: 7,
                        pointBackgroundColor: ChartConfig.colors.primary,
                        pointBorderColor: '#fff', pointBorderWidth: 2,
                        tension: 0.3,
                        yAxisID: 'y1', order: 0
                    }
                ]
            },
            options: {
                ...ChartConfig.defaultOptions,
                indexAxis: 'y',
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    ...ChartConfig.defaultOptions.plugins,
                    tooltip: {
                        ...ChartConfig.defaultOptions.plugins.tooltip,
                        callbacks: { label: ctx => ctx.dataset.label + ': ' + (ctx.parsed.x !== null ? ctx.parsed.x.toFixed(2) + '%' : '') }
                    }
                },
                scales: {
                    x: { ...ChartConfig.defaultOptions.scales.x, title: { display: true, text: 'Percentage (%)', font: { size: 12, weight: '600' } }, max: 100 },
                    y: { ...ChartConfig.defaultOptions.scales.y, title: { display: true, text: 'Defect Code', font: { size: 12, weight: '600' } } },
                    y1: {
                        ...ChartConfig.defaultOptions.scales.y,
                        type: 'linear', display: true, position: 'top',
                        title: { display: true, text: 'Cumulative (%)', font: { size: 12, weight: '600' } },
                        min: 0, max: 100, grid: { drawOnChartArea: false }
                    }
                },
                onClick: function(event, elements) {
                    if (elements.length > 0) {
                        const idx = elements[0].index;
                        document.dispatchEvent(new CustomEvent('defectSelected', { detail: { defectCode: data[idx].code } }));
                    }
                }
            }
        });
    },

    /* ===== CH-03: 责任部门分布 (环形图) ===== */
    createDepartmentDonutChart: function(ctx, data) {
        const labels = data.map(d => d.department);
        const qtyData = data.map(d => d.quantity);
        const palette = [
            ChartConfig.colors.primary, ChartConfig.colors.danger, ChartConfig.colors.success,
            ChartConfig.colors.warning, ChartConfig.colors.info, ChartConfig.colors.secondary,
            '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'
        ];

        return new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: qtyData,
                    backgroundColor: palette.slice(0, data.length),
                    borderColor: '#fff', borderWidth: 2, hoverOffset: 8
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'right',
                        labels: {
                            font: { size: 12, family: 'Inter, system-ui, sans-serif' },
                            padding: 12, usePointStyle: true,
                            generateLabels: function(chart) {
                                const d = chart.data;
                                if (!d.labels.length || !d.datasets.length) return [];
                                return d.labels.map((label, i) => ({
                                    text: label + ' (' + d.datasets[0].data[i] + ')',
                                    fillStyle: chart.getDatasetMeta(0).controller.getStyle(i).backgroundColor,
                                    strokeStyle: '#fff', lineWidth: 1,
                                    pointStyle: 'rectRounded', index: i
                                }));
                            }
                        }
                    },
                    tooltip: {
                        ...ChartConfig.defaultOptions.plugins.tooltip,
                        callbacks: {
                            label: function(ctx) {
                                const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                                const pct = ((ctx.parsed / total) * 100).toFixed(1);
                                return ctx.label + ': ' + ctx.parsed + ' (' + pct + '%)';
                            }
                        }
                    }
                },
                cutout: '60%',
                onClick: function(event, elements) {
                    if (elements.length > 0) {
                        const dept = data[elements[0].index].department;
                        document.dispatchEvent(new CustomEvent('departmentSelected', { detail: { department: dept } }));
                    }
                }
            }
        });
    },

    /* ===== 缺陷趋势对比图 ===== */
    createDefectTrendChart: function(ctx, defectTrendData, selectedDefectCode) {
        if (!defectTrendData || defectTrendData.length === 0) return null;

        const labels = defectTrendData.map(d => d.week);
        // 确定要显示哪些缺陷代码
        const sampleEntry = defectTrendData[0];
        const allCodes = Object.keys(sampleEntry).filter(k => k !== 'week' && k !== 'date');
        const codesToShow = selectedDefectCode ? [selectedDefectCode] : allCodes;

        const palette = [
            ChartConfig.colors.primary, ChartConfig.colors.danger, ChartConfig.colors.success,
            ChartConfig.colors.warning, ChartConfig.colors.info
        ];

        const datasets = codesToShow.map((code, i) => ({
            label: code,
            data: defectTrendData.map(w => w[code] || 0),
            borderColor: palette[i % palette.length],
            backgroundColor: palette[i % palette.length] + '20',
            borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, tension: 0.3
        }));

        return new Chart(ctx, {
            type: 'line',
            data: { labels: labels, datasets: datasets },
            options: {
                ...ChartConfig.defaultOptions,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    ...ChartConfig.defaultOptions.plugins,
                    tooltip: {
                        ...ChartConfig.defaultOptions.plugins.tooltip,
                        callbacks: { label: ctx => ctx.dataset.label + ': ' + ctx.parsed.y + ' units' }
                    }
                },
                scales: {
                    x: { ...ChartConfig.defaultOptions.scales.x, title: { display: true, text: 'Week', font: { size: 12, weight: '600' } } },
                    y: {
                        ...ChartConfig.defaultOptions.scales.y, beginAtZero: true,
                        title: { display: true, text: 'Defect Quantity', font: { size: 12, weight: '600' } }
                    }
                }
            }
        });
    }
};
