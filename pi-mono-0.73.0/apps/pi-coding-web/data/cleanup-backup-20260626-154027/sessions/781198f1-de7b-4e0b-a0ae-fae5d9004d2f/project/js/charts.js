/**
 * QDM Finished Lot Yield Dashboard - Chart Configurations
 * Uses ECharts for rendering
 */

const ChartConfig = {
    // Color palette (AITC compliant)
    colors: {
        primary: '#2563eb',
        primaryDark: '#1d4ed8',
        primaryLight: '#60a5fa',
        danger: '#c2413b',
        dangerLight: '#ef4444',
        warning: '#a56313',
        success: '#059669',
        gray: '#647280',
        grayLight: '#d9e1e7',
        background: '#f6f8fb',
        panel: '#ffffff',
        text: '#111315',
        textSecondary: '#424a55',
        // Chart specific colors
        yieldLine: '#2563eb',
        targetLine: '#c2413b',
        barFill: '#2563eb',
        barFillLight: 'rgba(37, 99, 235, 0.7)',
        paretoRed: '#c2413b',
        paretoBlue: '#2563eb',
        donutColors: ['#2563eb', '#60a5fa', '#a56313', '#059669', '#647280']
    },

    // Shared tooltip configuration
    tooltip: {
        backgroundColor: 'rgba(255, 255, 255, 0.96)',
        borderColor: '#d9e1e7',
        borderWidth: 1,
        textStyle: {
            color: '#111315',
            fontSize: 13,
            fontFamily: '"Arial Nova", "Plus Jakarta Sans", system-ui, sans-serif'
        },
        extraCssText: 'box-shadow: 0 4px 12px rgba(0,0,0,0.1); border-radius: 8px;'
    },

    // CH-01: Finished Overall Trend (Line + Bar)
    createYieldTrendChart(data, selectedWeek = null) {
        const weeks = data.map(d => d.week);
        const yields = data.map(d => d.yield);
        const targets = data.map(d => d.target);
        const outputs = data.map(d => d.output);

        return {
            tooltip: {
                ...ChartConfig.tooltip,
                trigger: 'axis',
                axisPointer: {
                    type: 'cross',
                    crossStyle: {
                        color: '#999'
                    }
                },
                formatter: function(params) {
                    let result = `<div style="font-weight:600;margin-bottom:8px;">Week ${params[0].axisValue}</div>`;
                    params.forEach(p => {
                        const marker = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:6px;"></span>`;
                        const value = p.seriesType === 'bar' ? `${p.value} lots` : `${p.value}%`;
                        result += `<div style="margin:4px 0;">${marker}${p.seriesName}: ${value}</div>`;
                    });
                    return result;
                }
            },
            legend: {
                data: ['Yield', 'Target', 'Output'],
                bottom: 0,
                textStyle: {
                    color: '#424a55',
                    fontSize: 12,
                    fontFamily: '"Arial Nova", "Plus Jakarta Sans", system-ui, sans-serif'
                },
                itemWidth: 12,
                itemHeight: 8,
                itemGap: 20
            },
            grid: {
                left: '3%',
                right: '4%',
                bottom: '12%',
                top: '8%',
                containLabel: true
            },
            xAxis: {
                type: 'category',
                data: weeks,
                axisLabel: {
                    color: '#424a55',
                    fontSize: 11,
                    rotate: 45
                },
                axisLine: {
                    lineStyle: {
                        color: '#d9e1e7'
                    }
                },
                axisTick: {
                    show: false
                }
            },
            yAxis: [
                {
                    type: 'value',
                    name: 'Yield (%)',
                    nameTextStyle: {
                        color: '#424a55',
                        fontSize: 11
                    },
                    min: 94,
                    max: 98,
                    axisLabel: {
                        color: '#424a55',
                        fontSize: 11,
                        formatter: '{value}%'
                    },
                    splitLine: {
                        lineStyle: {
                            color: '#eef2f4',
                            type: 'dashed'
                        }
                    }
                },
                {
                    type: 'value',
                    name: 'Output (lots)',
                    nameTextStyle: {
                        color: '#424a55',
                        fontSize: 11
                    },
                    axisLabel: {
                        color: '#424a55',
                        fontSize: 11
                    },
                    splitLine: {
                        show: false
                    }
                }
            ],
            series: [
                {
                    name: 'Output',
                    type: 'bar',
                    yAxisIndex: 1,
                    data: outputs,
                    itemStyle: {
                        color: function(params) {
                            return params.dataIndex === selectedWeek ? 
                                ChartConfig.colors.primary : 
                                ChartConfig.colors.barFillLight;
                        },
                        borderRadius: [4, 4, 0, 0]
                    },
                    barWidth: '50%',
                    emphasis: {
                        itemStyle: {
                            color: ChartConfig.colors.primary
                        }
                    }
                },
                {
                    name: 'Yield',
                    type: 'line',
                    data: yields,
                    smooth: true,
                    symbol: 'circle',
                    symbolSize: 8,
                    lineStyle: {
                        color: ChartConfig.colors.yieldLine,
                        width: 3
                    },
                    itemStyle: {
                        color: ChartConfig.colors.yieldLine,
                        borderWidth: 2,
                        borderColor: '#fff'
                    },
                    emphasis: {
                        itemStyle: {
                            borderWidth: 3
                        }
                    }
                },
                {
                    name: 'Target',
                    type: 'line',
                    data: targets,
                    lineStyle: {
                        color: ChartConfig.colors.targetLine,
                        type: 'dashed',
                        width: 2
                    },
                    itemStyle: {
                        color: ChartConfig.colors.targetLine
                    },
                    symbol: 'none'
                }
            ],
            dataZoom: [
                {
                    type: 'inside',
                    xAxisIndex: 0,
                    start: 0,
                    end: 100
                }
            ]
        };
    },

    // CH-02: Defect Loss Ratio (Horizontal Bar - Pareto)
    createDefectParetoChart(data, selectedCode = null) {
        const codes = data.map(d => d.code).reverse();
        const totalRatios = data.map(d => d.totalRatio).reverse();
        const coreRatios = data.map(d => d.coreRatio).reverse();

        return {
            tooltip: {
                ...ChartConfig.tooltip,
                trigger: 'axis',
                axisPointer: {
                    type: 'shadow'
                },
                formatter: function(params) {
                    const code = params[0].axisValue;
                    let result = `<div style="font-weight:600;margin-bottom:8px;">${code}</div>`;
                    params.forEach(p => {
                        const marker = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:6px;"></span>`;
                        result += `<div style="margin:4px 0;">${marker}${p.seriesName}: ${p.value}%</div>`;
                    });
                    return result;
                }
            },
            legend: {
                data: ['Total Loss Ratio', 'Core Loss Ratio'],
                bottom: 0,
                textStyle: {
                    color: '#424a55',
                    fontSize: 12
                },
                itemWidth: 12,
                itemHeight: 8
            },
            grid: {
                left: '3%',
                right: '4%',
                bottom: '12%',
                top: '4%',
                containLabel: true
            },
            xAxis: {
                type: 'value',
                axisLabel: {
                    color: '#424a55',
                    fontSize: 11,
                    formatter: '{value}%'
                },
                splitLine: {
                    lineStyle: {
                        color: '#eef2f4',
                        type: 'dashed'
                    }
                }
            },
            yAxis: {
                type: 'category',
                data: codes,
                axisLabel: {
                    color: function(value) {
                        return value === selectedCode ? ChartConfig.colors.primary : '#424a55';
                    },
                    fontSize: 12,
                    fontWeight: function(value) {
                        return value === selectedCode ? 600 : 400;
                    }
                },
                axisLine: {
                    lineStyle: {
                        color: '#d9e1e7'
                    }
                },
                axisTick: {
                    show: false
                }
            },
            series: [
                {
                    name: 'Total Loss Ratio',
                    type: 'bar',
                    data: totalRatios,
                    itemStyle: {
                        color: function(params) {
                            const code = codes[params.dataIndex];
                            return code === selectedCode ? 
                                ChartConfig.colors.danger : 
                                ChartConfig.colors.dangerLight;
                        },
                        borderRadius: [0, 4, 4, 0]
                    },
                    barWidth: '40%',
                    emphasis: {
                        itemStyle: {
                            color: ChartConfig.colors.danger
                        }
                    }
                },
                {
                    name: 'Core Loss Ratio',
                    type: 'bar',
                    data: coreRatios,
                    itemStyle: {
                        color: function(params) {
                            const code = codes[params.dataIndex];
                            return code === selectedCode ? 
                                ChartConfig.colors.primary : 
                                ChartConfig.colors.primaryLight;
                        },
                        borderRadius: [0, 4, 4, 0]
                    },
                    barWidth: '40%',
                    emphasis: {
                        itemStyle: {
                            color: ChartConfig.colors.primary
                        }
                    }
                }
            ]
        };
    },

    // Defect Code Trend Chart (Right panel)
    createDefectTrendChart(defectCode, trendData, weekLabels) {
        return {
            tooltip: {
                ...ChartConfig.tooltip,
                trigger: 'axis',
                formatter: function(params) {
                    let result = `<div style="font-weight:600;margin-bottom:8px;">Week ${params[0].axisValue}</div>`;
                    params.forEach(p => {
                        const marker = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:6px;"></span>`;
                        result += `<div style="margin:4px 0;">${marker}${p.seriesName}: ${p.value}%</div>`;
                    });
                    return result;
                }
            },
            grid: {
                left: '3%',
                right: '4%',
                bottom: '8%',
                top: '12%',
                containLabel: true
            },
            xAxis: {
                type: 'category',
                data: weekLabels,
                axisLabel: {
                    color: '#424a55',
                    fontSize: 10,
                    rotate: 45
                },
                axisLine: {
                    lineStyle: {
                        color: '#d9e1e7'
                    }
                }
            },
            yAxis: {
                type: 'value',
                name: 'Loss Ratio (%)',
                nameTextStyle: {
                    color: '#424a55',
                    fontSize: 10
                },
                axisLabel: {
                    color: '#424a55',
                    fontSize: 10,
                    formatter: '{value}%'
                },
                splitLine: {
                    lineStyle: {
                        color: '#eef2f4',
                        type: 'dashed'
                    }
                }
            },
            series: [
                {
                    name: defectCode,
                    type: 'line',
                    data: trendData,
                    smooth: true,
                    symbol: 'circle',
                    symbolSize: 6,
                    lineStyle: {
                        color: ChartConfig.colors.primary,
                        width: 2
                    },
                    itemStyle: {
                        color: ChartConfig.colors.primary,
                        borderWidth: 2,
                        borderColor: '#fff'
                    },
                    areaStyle: {
                        color: {
                            type: 'linear',
                            x: 0,
                            y: 0,
                            x2: 0,
                            y2: 1,
                            colorStops: [
                                { offset: 0, color: 'rgba(37, 99, 235, 0.3)' },
                                { offset: 1, color: 'rgba(37, 99, 235, 0.05)' }
                            ]
                        }
                    }
                }
            ]
        };
    },

    // Department Distribution Donut Chart
    createDepartmentDonutChart(departments) {
        return {
            tooltip: {
                ...ChartConfig.tooltip,
                trigger: 'item',
                formatter: '{b}: {c}%'
            },
            legend: {
                orient: 'vertical',
                right: '5%',
                top: 'center',
                textStyle: {
                    color: '#424a55',
                    fontSize: 11
                },
                itemWidth: 10,
                itemHeight: 10,
                itemGap: 12
            },
            series: [
                {
                    name: 'Department',
                    type: 'pie',
                    radius: ['45%', '70%'],
                    center: ['40%', '50%'],
                    avoidLabelOverlap: false,
                    itemStyle: {
                        borderRadius: 6,
                        borderColor: '#fff',
                        borderWidth: 2
                    },
                    label: {
                        show: false,
                        position: 'center'
                    },
                    emphasis: {
                        label: {
                            show: true,
                            fontSize: 14,
                            fontWeight: 600,
                            formatter: '{b}\n{d}%'
                        }
                    },
                    labelLine: {
                        show: false
                    },
                    data: departments.map((d, i) => ({
                        value: d.ratio,
                        name: d.dept,
                        itemStyle: {
                            color: ChartConfig.colors.donutColors[i % ChartConfig.colors.donutColors.length]
                        }
                    }))
                }
            ]
        };
    },

    // Yield Calculation Breakdown Chart
    createYieldBreakdownChart(data) {
        return {
            tooltip: {
                ...ChartConfig.tooltip,
                trigger: 'axis',
                formatter: function(params) {
                    let result = `<div style="font-weight:600;margin-bottom:8px;">${params[0].axisValue}</div>`;
                    params.forEach(p => {
                        result += `<div style="margin:4px 0;">Yield: ${p.value}%</div>`;
                    });
                    return result;
                }
            },
            grid: {
                left: '3%',
                right: '4%',
                bottom: '8%',
                top: '8%',
                containLabel: true
            },
            xAxis: {
                type: 'category',
                data: data.processes,
                axisLabel: {
                    color: '#424a55',
                    fontSize: 10
                },
                axisLine: {
                    lineStyle: {
                        color: '#d9e1e7'
                    }
                }
            },
            yAxis: {
                type: 'value',
                min: 98.5,
                max: 100,
                axisLabel: {
                    color: '#424a55',
                    fontSize: 10,
                    formatter: '{value}%'
                },
                splitLine: {
                    lineStyle: {
                        color: '#eef2f4',
                        type: 'dashed'
                    }
                }
            },
            series: [
                {
                    name: 'Process Yield',
                    type: 'bar',
                    data: data.yields,
                    itemStyle: {
                        color: ChartConfig.colors.primary,
                        borderRadius: [4, 4, 0, 0]
                    },
                    barWidth: '60%',
                    label: {
                        show: true,
                        position: 'top',
                        formatter: '{c}%',
                        fontSize: 10,
                        color: '#424a55'
                    }
                }
            ]
        };
    }
};

// Export for use
if (typeof window !== 'undefined') {
    window.ChartConfig = ChartConfig;
}
